# LFS pointer resolver

This Action takes a file list from the checked out (LFS skipped)
repository and iterates over pointer files, using their contents
to discover the "original" asset URL using the LFS API.

It then invokes a Lambda function on each key, with a set of
destination parameters to output print and preview resolution
files. Running this as a Github action allows visibility of the
process results, vs triggering the Lambda from S3 activity when
files are synced during an Action.

A further advantage is reduced IO during the build process as a
full checkout of LFS resources can be skipped.

## Inputs

### `MUSE_PRODUCT_SLUG`

The product slug to use as a subdirectory when uploading processed
files to their destination

### `AWS_S3_BUCKET`

S3 bucket for destination images

### `LAMBDA_TARGET`

The Lambda function to be invoked.

### `REPOSITORY`

The current repository, used for LFS authentication. Use the
`github.repository` context value.

### `LFS_DISCOVERY_ENDPOINT`

Git LFS API path for image discovery

### `PRINT_IMAGE_DPI`

Usually 300

### `PREVIEW_IMAGE_DPI`

Usually 72

## Env

### `AWS_ACCESS_KEY_ID`
### `AWS_SECRET_ACCESS_KEY`
### `AWS_REGION`

## Example usage

```
uses: Lostmyname/s3-lambda-process@v2
  with:
    MUSE_PRODUCT_SLUG: 'my-product-slug/commit_sha'
    AWS_S3_BUCKET: 'my-s3-bucket'
    LAMBDA_TARGET: 'my-lambda-function'
    REPOSITORY: ${{ github.repository }}
    LFS_DISCOVERY_ENDPOINT: 'https://github.com/foo/bar.git/info/lfs/objects/batch'
    PRINT_IMAGE_DPI: 300
    PREVIEW_IMAGE_DPI: 72
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: 'eu-west-1'
```
