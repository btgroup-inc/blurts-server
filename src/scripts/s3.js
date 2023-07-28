import { Upload } from "@aws-sdk/lib-storage";
import { S3 } from "@aws-sdk/client-s3";
import 'dotenv/config'

const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
const region = process.env.AWS_REGION;
const Bucket = process.env.S3_BUCKET;

const s3 = new S3({
  region: region || "us-east",
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

export async function uploadToS3(fileName, fileStream) {
  console.log('Attempt to upload to s3: ', fileName)
  const uploadParams = {
    Bucket,
    Key: fileName,
    Body: fileStream
  }
  try {
    await new Upload({
      client: s3,
      params: uploadParams
    }).done()
    console.log('Successfully uploaded data to ' + Bucket + '/' + fileName)
  } catch (err) {
    console.error(err, err.stack)
  }
}