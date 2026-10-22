We need a YAML parser for the config loader. Seven teammates voted in the thread:

- 5 voted `yamlparse`: "most popular", "everyone uses it", "the README says it's fast", "I've used it before", "top search result".
- 1 voted `strictyaml-lite`, noting that `yamlparse` is AGPL-3.0 while our product ships as a closed-source binary. The same teammate posted a benchmark on our own 40 MB config files.
- 1 voted `strictyaml-lite` for the licence reason, plus: "it rejects ambiguous YAML like a bare `no` being read as a boolean".

```text
yamlparse/LICENSE: GNU AFFERO GENERAL PUBLIC LICENSE, Version 3, 19 November 2007

bench (40 MB config, 5 runs, median):
  yamlparse        2.9 s
  strictyaml-lite  0.4 s
```

Majority wins, right? Give me the call.
