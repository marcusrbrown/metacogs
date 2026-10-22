This compose file fails to parse. I think it is an indentation problem. Fix it and reply with the corrected file.

```yaml
services:
  web:
    image: example/web:1.4
    ports:
      - "8080:80"
   environment:
      LOG_LEVEL: info
  cache:
    image: example/cache:7
```
