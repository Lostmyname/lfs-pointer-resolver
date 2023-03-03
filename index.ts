import { exec } from 'child_process';

import * as core from '@actions/core';
import async from 'async';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import glob from 'glob';
import { chunk, zipWith } from 'lodash';
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

const MUSE_PRODUCT_SLUG = core.getInput('MUSE_PRODUCT_SLUG');
const MUSE_S3_BUCKET = core.getInput('AWS_S3_BUCKET');

const PRINT_IMAGE_DPI = parseInt(core.getInput('PRINT_IMAGE_DPI'));
const PREVIEW_IMAGE_DPI = parseInt(core.getInput('PREVIEW_IMAGE_DPI'));

const REPOSITORY = core.getInput('REPOSITORY');
const SOURCE_DIR = core.getInput('SOURCE_DIR');

const LFS_ENDPOINT = core.getInput('LFS_DISCOVERY_ENDPOINT')
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

const getImages = (): string[] => {
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
  return `${MUSE_PRODUCT_SLUG}/${mode}/${fileName}`;
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
const resolvePointers = async (assets: Asset[]) => {
  const data = JSON.parse(JSON.stringify(LFS_TEMPLATE));
  data.objects = assets.map(x => x.opts);

  if (LFS_HEADERS.Authorization === null) {
    throw new Error('No auth token present');
  }

  try {
    const response = await fetch(LFS_ENDPOINT, {
      method: 'POST',
      headers: LFS_HEADERS,
      body: JSON.stringify(data),
    }).then(res => {
      if (!res.ok) {
        throw new Error(`Could not fetch`);
      }

      return res.json();
    }).then((data: {
      objects: ResolvedFile[]
    }) => {
      return data.objects.map((x) => x.actions.download.href);
    });

    // stitch resolved pointer URL and original data back together
    return zipWith(response, assets, (url: string, asset: Asset) => {
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
        destinations: [printDestination, previewDestination]
      }
    });
  } catch(error) {
    throw new Error(error);
  }
}

const processImage = async (opts: InvocationOptions) => {
  const LAMBDA_TARGET = core.getInput('LAMBDA_TARGET');
  const params = new TextEncoder().encode(JSON.stringify(opts));

  const command = new InvokeCommand({
    FunctionName: LAMBDA_TARGET,
    InvocationType: 'RequestResponse',
    Payload: params,
  });

  try {
    const { Payload, FunctionError } = await lambda.send(command);
    const result = new TextDecoder().decode(Payload);

    // Lambda will return a 200 even if it errors but we can check for the
    // FunctionError property in the response and then interrogate the payload
    // for details
    if (FunctionError) {
      throw new Error(result);
    }

    console.log(`Completed ${opts.destinations.map(x => x.key).join(', ')}`)
    return result;

  } catch (err) {
    throw new Error(err);
  }
};

const resolveAndProcess = async (assets: Asset[], i: number, next: () => void) => {
  // max Lambda concurrency
  const lambdaConcurrency = 1000;

  console.log(`resolve and process batch ${i+1} for ${assets.length} pointers`);

  const sourceUrls = await resolvePointers(assets);

  // invoke the lambda processor at max concurrency
  await async.eachLimit(sourceUrls, lambdaConcurrency, processImage);

  next();
}

const main = async () => {
  console.time('Process time');

  // fetch an auth token and apply to header template
  const token = await getAuth();
  LFS_HEADERS.Authorization = token;

  // collect files to process
  const files = getImages();
  // chunk size of URLs to resolve in batches via the Github API
  const resolverChunkSize = 50;

  console.log(`${files.length} files to process`);

  try {
    // iterate over LFS pointer files and get source URL from oid
    const pointerData = await Promise.all(files.map(x => processPointer(x))).then(res => chunk(res, resolverChunkSize));

    await new Promise((resolve: any) => {
      async.eachOfSeries(pointerData, resolveAndProcess, (err) => {
        if (err) {
          throw new Error(err.message);
        }

        console.log('Completed batch processing');
        resolve();
      });
    });

    console.log(`Processed ${files.length} files`);
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
