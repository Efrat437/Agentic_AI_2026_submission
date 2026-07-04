$body = '{"query":"What is Tel Aviv?"}'
curl.exe -X POST http://127.0.0.1:4000/ask -H "Content-Type: application/json" -d $body
