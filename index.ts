import { exec } from 'child_process';

import * as core from '@actions/core';
import async from 'async';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs-extra';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import glob from 'glob';
import { chunk, zipWith, flatten, union, uniq } from 'lodash';
import mimeTypes from 'mime-types';

type Asset = {
  fileName: string;
  opts: {
    oid: string;
  };
};

type InvocationOptions = {
  source: {
    url: string;
  },
  destinations: {
    key: string
  }[];
};

type ResolvedFile = {
  actions: {
    download: {
      href: string;
    }
  }
}

const lambda = new LambdaClient({
  region: 'eu-west-1',
});

const s3 = new S3Client({
  region: 'eu-west-1',
});

const MUSE_S3_BUCKET = core.getInput('AWS_S3_BUCKET');

const PRINT_IMAGE_DPI = parseInt(core.getInput('PRINT_IMAGE_DPI'));
const PREVIEW_IMAGE_DPI = parseInt(core.getInput('PREVIEW_IMAGE_DPI'));

const REPOSITORY = core.getInput('REPOSITORY');
const SOURCE_DIR = core.getInput('SOURCE_DIR');
const MODIFIED_IMAGES = core.getInput('MODIFIED_IMAGES');

const ASSET_VERSION = core.getInput('ASSET_VERSION');
const ASSET_VERSION_BEFORE = core.getInput('ASSET_VERSION_BEFORE');

const LFS_ENDPOINT = core.getInput('LFS_DISCOVERY_ENDPOINT')
const LAMBDA_TARGET = core.getInput('LAMBDA_TARGET');

const LFS_TEMPLATE = {
  "operation": "download",
  "transfers": [ "basic "],
  "ref": { "name": "refs/heads/master" },
  "objects": []
}
let LFS_HEADERS = {
  'Accept': 'application/vnd.git-lfs+json',
  'Content-Type': 'application/vnd.git-lfs+json',
  'Authorization': null,
};

const getModifiedImages = async (): Promise<string[] | null> => {
  try {
    const files = await fs.readFile(`./${MODIFIED_IMAGES}`, 'utf8').then(body => body.split(' '));

    // no contents, return early
    if (files.length === 1 && files[0] === '') {
      return null;
    }

    // construct array with file paths
    return files.map(x => `./${x.replace('\n', '')}`);
  } catch(error) {
    throw new Error(`Could not get modified images. ${error}`);
  }
}

const getImages = async (): Promise<string[]> => {
  return glob
    .sync(`./${SOURCE_DIR}/images/**/*`, {nodir: true})
    .reduce((acc, file) => {
      const mt = mimeTypes.lookup(file) || '';
      if (mt.startsWith('image/') && !mt.includes('svg')) {
        acc.push(file);
      }
      return acc;
    }, []);
}

const getAuth = (): Promise<string> => {
  const cmd = `ssh git@github.com git-lfs-authenticate ${REPOSITORY} download`; // config
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve(stdout ? JSON.parse(stdout).header.Authorization : stderr);
    });
  });
}

const createKey = (mode: string, fileName: string) => {
  return `${REPOSITORY}/${ASSET_VERSION}/${mode}/${fileName}`;
}

// read an LFS pointer file and parse it's oid and size
// return with the file name because we need to map this with the resolved url later
const processPointer = async (path: string) => {
  const file = await fs.readFile(path, 'utf8').then(body => body.split(/\n/));

  const oid = file[1].split(':')[1];
  const size = parseInt(file[2].split(' ')[1]);
  const fileName = path.split(`${SOURCE_DIR}/`)[1];

  return {
    fileName,
    // object pattern required for LFS API
    opts: {
      oid,
      size,
    }
  }
}

// take a batch of pointer data, resolve urls, and create onward data for Lambda
const resolveAndProcess = async (assets: Asset[], i: number, next: (err?: Error) => void) => {
  console.log(`Resolve and process batch ${i+1} for ${assets.length} pointers`);

  const lambdaConcurrency = 1000;
  const data = JSON.parse(JSON.stringify(LFS_TEMPLATE));
  data.objects = assets.map(x => x.opts);

  // fetch an auth token and apply to header template
  // do this each time because the token has a 600 second TTL
  // and will otherwise expire on a long build
  const token = await getAuth();
  LFS_HEADERS.Authorization = token;

  if (LFS_HEADERS.Authorization === null) {
    throw new Error('No auth token present');
  }

  axiosRetry(axios, {
    retries: 3,
    onRetry: (retryCount, error) => {
      console.log(`retrying ${retryCount}`);
      // console.log(error.toJSON());
    }
  });

  const response = await axios.post(
    LFS_ENDPOINT,
    data,
    {
      headers: LFS_HEADERS,
    }).then(res => {
      const { objects }: { objects: ResolvedFile[] } = res.data;
      return objects.map((x) => x.actions.download.href);
    });

  if (!response) {
    throw new Error('No response from resolver API');
  }

  try {

    // stitch resolved pointer URL and original data back together
    const sourceUrls = zipWith(response, assets, (url: string, asset: Asset): InvocationOptions => {
      if (url.indexOf(asset.opts.oid) === -1) {
        throw new Error(`Mismatch between pointer oid and resolved url for ${asset.fileName}`);
      };

      const printDestination = {
        type: 's3',
        bucket: MUSE_S3_BUCKET,
        key: createKey('print', asset.fileName),
        scale: 1,
      }

      const previewDestination = {
        type: 's3',
        bucket: MUSE_S3_BUCKET,
        key: createKey('preview', asset.fileName),
        scale: PREVIEW_IMAGE_DPI / PRINT_IMAGE_DPI,
      }

      return {
        source: {
          url,
        },
        destinations: [printDestination, previewDestination],
      }
    });

    // invoke the lambda processor at max concurrency
    await new Promise((resolve: any) => {
      async.eachLimit(sourceUrls, lambdaConcurrency, async (opts: InvocationOptions, next: (err?: Error) => void) => {
        const params = new TextEncoder().encode(JSON.stringify(opts));

        const invokeLambdaFunction = async (command: InvokeCommand) => {
          const { Payload, FunctionError } = await lambda.send(command);
          const DecodedPayload = new TextDecoder().decode(Payload);

          return { DecodedPayload, FunctionError};
        }

        const command = new InvokeCommand({
          FunctionName: LAMBDA_TARGET,
          InvocationType: 'RequestResponse',
          Payload: params,
        });

        let lambdaAttempts = 0;
        let result = await invokeLambdaFunction(command);

        // Lambda will return a 200 even if it errors but we can check for the
        // FunctionError property in the response and then interrogate the payload
        // for details. We also give it one attempt at a retry in case e.g.
        // the initial invocation timed out or had an I/O error
        if (result.FunctionError && lambdaAttempts < 1) {
          result = await invokeLambdaFunction(command);
          lambdaAttempts++;
        }

        if (result.FunctionError) {
          throw new Error(result.DecodedPayload);
        }

        // console.log(`Completed ${opts.destinations.map(x => x.key).join(', ')}`);

        next(null);
      }, (err) => {
        if (err) {
          throw new Error(err.message);
        }

        console.log(`Completed batch ${i+1} for ${assets.length} pointers`);
        resolve();
      });
    });

    next(null);
  } catch(error) {
    throw new Error(error);
  }
}

const main = async () => {
  console.time('Process time');

  // collect modified images in this commit
  const modifiedImages = await getModifiedImages();
  // collect files to process, look inside the product's static-assets folder
  const files = await getImages();
  // chunk size of URLs to resolve in batches via the Github API
  const resolverChunkSize = 50;
  
  console.log(`${files.length} images in product. ${modifiedImages.length} modified files in this commit.`);

  // construct file paths for preview/print to match the S3 key
  const fileSelection = flatten(files.map(x => {
    const filename = x.split(`${SOURCE_DIR}/`)[1];
    return [
      `${REPOSITORY}/${ASSET_VERSION_BEFORE}/preview/${filename}`,
      `${REPOSITORY}/${ASSET_VERSION_BEFORE}/print/${filename}`
    ];
  }));

  const uncopiedFiles = [];

  const copyAllFiles = async () => {
    const batches = chunk(fileSelection, resolverChunkSize);
    console.log(`Copying files from ${REPOSITORY}/${ASSET_VERSION_BEFORE}...`);
    
    while (batches.length) {
      const batch = batches.shift();
      await Promise.all(batch.map(async sourceKey => {
        // construct destination file path
        const destKey = sourceKey.replace(ASSET_VERSION_BEFORE, ASSET_VERSION);
        
        // set up S3 destination
        const command = new CopyObjectCommand({
          Bucket: MUSE_S3_BUCKET,
          CopySource: `${MUSE_S3_BUCKET}/${sourceKey}`,
          Key: destKey,
        });
        
        try {
          // check if the files from static-assets exist in S3 source folder
          // and try to copy matching files
          await s3.send(command);
        } catch (error) {
          // push non-matching files to a new array to process later
          if (error.Code === 'NoSuchKey') {
            uncopiedFiles.push(destKey);
          } else {
            throw new Error(error);
          }
        }
      }));
    };
  }

  await copyAllFiles()

  // remove duplicated files
  const deduplicatedUncopiedFiles = uniq(uncopiedFiles.map(x => x.split(/preview|print/)[1])).map(x => `./static-assets${x}`);

  console.log(`${deduplicatedUncopiedFiles.length} uncopied files to process later`)
  // Files to process are new modified images + previously uncopied files
  const filesToProcess = union(deduplicatedUncopiedFiles, modifiedImages);

  console.log(`${filesToProcess.length} files need processing`);

  try {
    // iterate over LFS pointer files and get source URL from oid
    const pointerData = await Promise.all(filesToProcess.map(x => processPointer(x))).then(res => chunk(res, resolverChunkSize));

    await new Promise((resolve: any) => {
      async.eachOfSeries(pointerData, resolveAndProcess, (err) => {
        if (err) {
          throw new Error(err.message);
        }

        console.log('Completed batch processing');
        resolve();
      });
    });

    console.log(`Processed ${filesToProcess.length} files`);

  } catch(error) {
    core.setFailed(error);
  };

  console.timeEnd('Process time');
}

try {
  main();
} catch (error) {
  console.log(error.message);
  core.setFailed(error.message);
}
