# Test Events

Place Lambda test payloads here for local invocation.

## Naming convention

```
test-events/
└── <FunctionName>/
    ├── eventbridge-schedule.json
    ├── api-get.json
    └── dynamodb-stream-insert.json
```

## Invoke via AWS CLI

```bash
aws lambda invoke \
  --function-name PollerFunction:dev \
  --payload file://test-events/PollerFunction/eventbridge-schedule.json \
  --cli-binary-format raw-in-base64-out \
  response.json && cat response.json
```

## API Gateway event template (DashboardApiFunction)

```json
{
  "httpMethod": "GET",
  "path": "/readings",
  "pathParameters": null,
  "queryStringParameters": { "range": "week" },
  "headers": { "X-Api-Key": "<api-key>" },
  "body": null
}
```

## DynamoDB Stream event template (AlertFunction)

```json
{
  "Records": [{
    "eventSource": "aws:dynamodb",
    "eventName": "INSERT",
    "dynamodb": {
      "NewImage": {
        "DeviceSn":     { "S": "H34ABCDEFG5001" },
        "Timestamp":    { "N": "1753776000" },
        "deviceStatus": { "N": "1" }
      }
    }
  }]
}
```
