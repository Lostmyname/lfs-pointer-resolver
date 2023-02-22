import { exec } from 'child_process';

import * as core from '@actions/core';
import async from 'async';
import * as AWS from 'aws-sdk';
import fs from 'fs-extra';
import glob from 'glob';
import { chunk, flatten, zipWith } from 'lodash';
import mimeTypes from 'mime-types';
import { promisify } from 'util';

type Asset = {
  fileName: string;
  opts: {
    oid: string;
  };
};

const lambda = new AWS.Lambda();

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

const readFile = promisify(fs.readFile);

const getImages = () => {
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

const getAuth = () => {
  const cmd = `ssh git@github.com git-lfs-authenticate ${REPOSITORY} download`; // config
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve(stdout ? JSON.parse(stdout).header.Authorization : stderr);
    });
  });
}

const createKey = (mode, fileName) => {
  return `${MUSE_PRODUCT_SLUG}/${mode}/${fileName}`;
}

// read an LFS pointer file and parse it's oid and size
// return with the file name because we need to map this with the resolved url later
const processPointer = async (path) => {
  const file = await readFile(path, 'utf8').then(body => body.split(/\n/));

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
const resolvePointers = async (assets) => {
  console.log(`Resolving ${assets.length} pointers`);

  const data = JSON.parse(JSON.stringify(LFS_TEMPLATE));
  data.objects = assets.map(x => x.opts);

  if (LFS_HEADERS.Authorization === null) {
    throw new Error('No auth token present');
  }

  try {
    const response = await fetch(LFS_ENDPOINT, {
      method: 'POST',
      headers: LFS_HEADERS,
      credentials: 'include',
      body: JSON.stringify(data),
    }).then(res => {
      if (!res.ok) {
        throw new Error(`Could not fetch`);
      }

      return res.json();
    }).then(data => {
      return data.objects.map(x => x.actions.download.href);
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

const processImage = async (opts) => {
  const LAMBDA_TARGET = core.getInput('LAMBDA_TARGET');

  const invoke = (opts) => {
    return lambda.invoke({
      FunctionName: LAMBDA_TARGET,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(opts),
    }).promise();
  }

  const result = await invoke(opts).then(res => {
    // Lambda will return a 200 even if it errors but we can check for the FunctionError property in the response and then interrogate the payload for details
    if (res.FunctionError) {
      const errorPayload = JSON.parse(res.Payload as string);

      throw new Error(errorPayload.errorMessage);
    }
    console.log(`Completed ${opts.destinations.map(x => x.key).join(', ')}`)
    return res.Payload;
  }).catch(err => {
    throw new Error(err);
  });

  return result;
};

const main = async () => {
  console.time('Process time');

  // fetch an auth token and apply to header template
  const token = await getAuth();
  LFS_HEADERS.Authorization = token;

  // collect files to process
  const files = getImages();
  // chunk size of URLs to resolve in batches via the Github API
  const resolverChunkSize = 50;
  // concurrency is a bit of guesswork here to keep the Github API happy
  const resolverConcurrency = 10;
  // max Lambda concurrency
  const lambdaConcurrency = 1000;

  try {
    // iterate over LFS pointer files and get source URL from oid
    const pointerData = await Promise.all(files.map(x => processPointer(x))).then(res => chunk(res, resolverChunkSize));

    // resolve URLs in batches - concurrency is a bit of guesswork here to keep the Github API happy
    const sourceUrls = await async.mapLimit(pointerData, resolverConcurrency, resolvePointers);

    // invoke the lambda processor at max concurrency
    await async.eachLimit(flatten(sourceUrls), lambdaConcurrency, processImage);

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
