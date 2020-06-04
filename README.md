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

### `muse_product_slug`

**REQUIRED** The product slug to use as a subdirectory when uploading processed
files to their destination.

### `aws_s3_bucket`

**REQUIRED** S3 bucket for destination images.

### `lambda_target`

The Lambda function to be invoked.

### `repository`

**REQUIRED** The current repository, used for LFS authentication. Use the
`github.repository` context value.

### `lfs_discovery_endpoint`

**REQUIRED** Git LFS API path for image discovery

### `source_dir`

Project directory where source images are located. Default `./static-assets/images`

### `print_image_dpi`

Default 300

### `preview_image_dpi`

Default 72

## Env

### `AWS_ACCESS_KEY_ID`
### `AWS_SECRET_ACCESS_KEY`
### `AWS_REGION`

## Example usage

```
uses: Lostmyname/lfs-pointer-resolver@v3
  with:
    muse_product_slug: 'my-product-slug/commit_sha'
    aws_s3_bucket: 'my-s3-bucket'
    lambda_target: 'my-lambda-function'
    repository: ${{ github.repository }}
    lfs_discovery_endpoint: 'https://github.com/foo/bar.git/info/lfs/objects/batch'
    print_image_dpi: 300
    preview_image_dpi: 72
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: 'eu-west-1'
```
