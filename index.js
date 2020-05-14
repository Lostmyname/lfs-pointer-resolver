const { exec } = require('child_process');

const async = require('async');
const AWS = require('aws-sdk');
const core = require('@actions/core');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const glob = require('glob');
const mimeTypes = require('mime-types');
const util = require('util');

const lambda = new AWS.Lambda();

const MUSE_PRODUCT_SLUG = core.getInput('MUSE_PRODUCT_SLUG');
const MUSE_S3_BUCKET = core.getInput('AWS_S3_BUCKET');

const PRINT_IMAGE_DPI = parseInt(core.getInput('PRINT_IMAGE_DPI'));
const PREVIEW_IMAGE_DPI = parseInt(core.getInput('PREVIEW_IMAGE_DPI'));

const REPOSITORY = core.getInput('REPOSITORY');
const STATIC_DIR = './static-assets/images'; // send as config?

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

const readFile = util.promisify(fs.readFile);

const getImages = () => {
  return glob
    .sync(`${STATIC_DIR}/**/*`, {nodir: true})
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

const getSourceUrl = async (opts) => {
  const data = JSON.parse(JSON.stringify(LFS_TEMPLATE));
  data.objects.push(opts);

  if (LFS_HEADERS.Authorization === null) {
    throw new Error('No auth token present');
  }

  return await fetch(LFS_ENDPOINT, {
    method: 'POST',
    headers: LFS_HEADERS,
    credentials: 'include',
    body: JSON.stringify(data),
  }).then(res => {
    if (!res.ok)  {
      throw new Error(`Could not fetch`);
    }

    return res.json();
  }).then(data => {
    return data.objects.map(x => x.actions.download.href).join();
  });
}

const processPointer = async (path) => {
  const file = await readFile(path, 'utf8').then(body => body.split(/\n/));

  const oid = file[1].split(':')[1];
  const size = parseInt(file[2].split(' ')[1]);

  // object pattern required for LFS API
  const opts = {
    oid,
    size,
  }

  const url = await getSourceUrl(opts);
  const fileName = path.split('static-assets/')[1];

  const printDestination = {
    type: 's3',
    bucket: MUSE_S3_BUCKET,
    key: createKey('print', fileName),
    scale: 1,
  }

  const previewDestination = {
    type: 's3',
    bucket: MUSE_S3_BUCKET,
    key: createKey('preview', fileName),
    scale: PREVIEW_IMAGE_DPI / PRINT_IMAGE_DPI,
  }

  const data = {
    source: {
      url,
    },
    destinations: [printDestination, previewDestination],
  }

  return data;
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
    console.log(`Completed ${opts.destinations.map(x => x.key).join(', ')}`)
    return res.Payload;
  }).catch(err => console.log(err));

  return result;
};

const main = async () => {
  console.time('Process time');

  // fetch an auth token and apply to header template
  const token = await getAuth();
  LFS_HEADERS.Authorization = token;

  // collect files to process
  const files = getImages();
  const concurrency = 1000;

  // iterate over LFS pointer files and get source URL from oid
  const sourceUrls = await Promise.all(files.map(x => processPointer(x)));

  // invoke the lambda processor at max concurrency
  await async.eachLimit(sourceUrls, concurrency, processImage);

  console.log(`Processed ${files.length} files`);
  console.timeEnd('Process time');
}

try {
  main();
} catch (error) {
  console.log(error.message);
  core.setFailed(error.message);
}
