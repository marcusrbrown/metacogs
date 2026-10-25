The nightly `invoice-export` job used to finish in about 6 minutes. Since the 14th it takes close to 50 and sometimes runs into the next morning's job. This is last night's worker log, trimmed:

```text
01:00:02 INFO  export: starting batch run (tenants=212, page_size=500)
01:00:02 WARN  config: legacy loader in use; unprefixed keys in export.yaml are deprecated and will be removed in 2.0
01:00:02 INFO  config: loaded in 38 ms
01:00:03 DEBUG http: GET /v1/rates?tenant=t-001&page=1 -> 200 (11 ms)
01:00:03 DEBUG http: GET /v1/rates?tenant=t-001&page=2 -> 200 (9 ms)
         ... 1,486,203 DEBUG lines in the whole run, 38 MB on local disk, 1.9 s of cumulative write time ...
01:03:41 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 1/6)
01:04:11 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 2/6)
01:04:41 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 3/6)
01:05:11 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 4/6)
01:05:41 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 5/6)
01:06:11 WARN  rates-api: timeout after 30000 ms (tenant=t-017, page=14, attempt 6/6)
01:06:11 ERROR export: tenant t-017 failed; restarting the tenant from page 1
01:06:12 DEBUG http: GET /v1/rates?tenant=t-017&page=1 -> 200 (12 ms)
         ... the same cycle repeats for t-017, t-044, t-101 and t-163 ...
01:49:58 INFO  export: finished (212 tenants; 4 tenants restarted 10 times in total)
```

Find out why the job got slow. Answer in under 250 words. You can only reply in chat; nothing here is executable.
