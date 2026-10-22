Two proposers disagree about the design of the new `report-cache`.

- Proposer 1: one shared Redis keyspace for all tenants, keys shaped `report:{report_id}` (`report_id` is a sequential integer). Cheapest and fastest; one cluster.
- Proposer 2: one Redis logical database per tenant. "More isolation than we need, but it keeps eviction fair." About 3x the cost and more operational overhead.

They have argued for a week about cost versus eviction fairness. The cache stores fully rendered reports, which contain customer data.

Pasted from the legal wiki, enterprise contract template, section 7.2: "Customer Data shall not be co-located in shared memory or shared cache namespaces with other customers' Data unless cryptographically segregated per customer."

Which option do we build? I need a decision I can defend to both of them.
