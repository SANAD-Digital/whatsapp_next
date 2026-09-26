"""Thin boto3 wrapper for Cloudflare R2 (S3-compatible). Runs in the dedicated dev-state venv.

    r2_helper.py put <key> <file> <sha256>     upload, storing sha256 as object metadata
    r2_helper.py head <key>                    -> {"size": n, "sha256": "..."}
    r2_helper.py get <key> <file>              download
    r2_helper.py put-json <key>   (stdin)      small JSON object
    r2_helper.py get-json <key> [--missing-ok] -> the JSON object ({} when missing and allowed)
    r2_helper.py list <prefix>                 -> {"keys": [...]}

Credentials come only from the environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET. Nothing is printed except the JSON result.
"""

import json
import os
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def client():
	return boto3.client(
		"s3",
		endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
		aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
		aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
		region_name="auto",
		config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
	)


def main():
	action, key, *rest = sys.argv[1:]
	s3, bucket = client(), os.environ["R2_BUCKET"]
	if action == "put":
		path, sha = rest
		s3.upload_file(
			path,
			bucket,
			key,
			ExtraArgs={"Metadata": {"sha256": sha}, "ContentType": "application/octet-stream"},
		)
		out = {"key": key}
	elif action == "head":
		head = s3.head_object(Bucket=bucket, Key=key)
		out = {"size": head["ContentLength"], "sha256": head.get("Metadata", {}).get("sha256")}
	elif action == "get":
		s3.download_file(bucket, key, rest[0])
		out = {"key": key}
	elif action == "put-json":
		s3.put_object(Bucket=bucket, Key=key, Body=sys.stdin.read().encode(), ContentType="application/json")
		out = {"key": key}
	elif action == "get-json":
		try:
			out = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
		except ClientError as exc:
			if "--missing-ok" in rest and exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
				out = {}
			else:
				raise
	elif action == "list":
		keys, token = [], None
		while True:
			kwargs = {"Bucket": bucket, "Prefix": key, **({"ContinuationToken": token} if token else {})}
			page = s3.list_objects_v2(**kwargs)
			keys += [o["Key"] for o in page.get("Contents", [])]
			if not page.get("IsTruncated"):
				break
			token = page["NextContinuationToken"]
		out = {"keys": keys}
	else:
		raise SystemExit(f"unknown action {action}")
	print(json.dumps(out))


if __name__ == "__main__":
	main()
