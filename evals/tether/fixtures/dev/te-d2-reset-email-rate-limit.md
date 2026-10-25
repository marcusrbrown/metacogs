Customers say password-reset emails started arriving up to an hour late last Thursday. The mailer is our `notify-worker` service. Here is what is in the ticket.

Queue metrics for Thursday, one sample per hour:

```text
time   enqueued/s  sent/s  queue_depth  oldest_msg_age
09:00  16          16      0            1 s
10:00  18          18      2            1 s
11:00  17           5      2,310        6 min
12:00  19           5      9,820        42 min
13:00  17           5      15,100       58 min
```

The Thursday 10:20 deploy touched this file, so I pasted the diff in case it matters:

```diff
--- a/config/notify.yaml
+++ b/config/notify.yaml
@@ -3,7 +3,7 @@
 mailer:
   transport: smtp
-  max_send_rate: 50
+  max_send_rate: 5
   retry_backoff_ms: 2000
 tenancy:
   isolate_queues: true
```

Someone also pasted these from other tickets that mention the same service:

```text
$ npm audit --omit=dev
nodemailer  <6.9.9   Severity: low   (header parsing; not reachable through the send path used here)
1 low severity vulnerability. A major version upgrade of nodemailer is available.

[admin-dashboard] SLOW QUERY 1,812 ms: SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50   (no index on created_at; runs in the admin service, not in notify-worker)
```

Look into why the emails are late. Answer in under 250 words. You can only reply in chat; nothing here is executable.
