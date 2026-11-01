---
mindslate: map
tags: [databases]
---
# Sharding

- Why shard
	- Too much data or write load
	  for one node
		- Reads alone? Use replicas instead
	- Horizontal scale-out
	- Per-core sharding on one machine
	  Redis, VoltDB, FoundationDB
	- Costs
		- Must choose a partition key
		- Scheme is hard to change
		- Cross-shard joins and indexes
		- Distributed transactions
		  see Ch. 8
	- Replication is orthogonal
	  each shard replicated (Ch. 6)
	- Many names
	  partition, range, region, tablet, vnode
- Multitenancy
	- Shard per tenant
	  or small tenants grouped
	- Case: email marketing SaaS
	- Benefits
		- Resource isolation
		- Permission isolation
		- Cell-based architecture
		- Per-tenant backup and restore
		- GDPR and CCPA compliance
		- Data residence
		- Gradual schema rollout
	- Limits
		- Tenant bigger than one node
		- Moving tenants as they grow
		- Cross-tenant joins
- Key-range sharding
	- Contiguous key ranges
	  like encyclopedia volumes
	- Sorted within each shard
	  range scans are cheap
	- Boundaries
		- Manual: Vitess
		- Automatic: HBase, Bigtable, CockroachDB
	- Hot spot on nearby keys
		- Case: sensor timestamps
		- Fix: key = (sensor ID, timestamp)
		- Cost: one query per sensor
	- Rebalancing
		- Pre-splitting
		- Split at size or load
		  HBase default 10 GB
		- Merge after deletes
		- Split is costly under load
- Hash sharding
	- Uniform spread
	  MD5, Murmur3
	- Avoid Java hashCode, Ruby hash
	- Loses key order
	- Hash mod N
		- Most keys move on resize
		  9 of 12 keys, 3 to 4 nodes
	- Fixed number of shards
		- Move whole shards, not keys
		- Nodes can't exceed shards
		- Shard size grows with data
		- Citus, Riak, Elasticsearch, Couchbase
	- Hash range
		- Splits like key range
		- Range scans on sort key only
		- DynamoDB, YugabyteDB
	- Consistent hashing
		- Balanced keys per shard
		- Minimal movement on resize
		- Ring with virtual nodes
		  Cassandra 16, ScyllaDB 256
		- Rendezvous hashing
		- Jump consistent hashing
		- Not replica or ACID consistency
- Hot spots
	- Even keys, uneven load
	- Case: celebrity post
	- Isolate hot key in own shard
	- Random suffix on key
		- Writes split across 100 keys
		- Reads fan out and merge
		- Track which keys are split
	- Load changes over time
	- Automated: heat management
	  adaptive capacity
- Rebalancing operations
	- Automatic: DynamoDB
	- Suggest then commit: Couchbase, Riak
	- Manual: pre-scale for known peaks
	- Risk: cascading failure
		- Slow node judged dead
		- Its load moves to others
		- Others overload too
- Request routing
	- Approaches
		- Any node forwards
		- Routing tier
		- Shard-aware client
	- Open questions
		- Who assigns shards to nodes
		- How routers learn of changes
		- In-flight requests at cutover
	- Coordination
		- ZooKeeper: HBase, SolrCloud
		- etcd: Kubernetes
		- Built-in Raft: Kafka, TiDB, ScyllaDB
		- MongoDB: config servers and mongos
		- Gossip: Riak
		  weaker, split brain possible
	- DNS for node addresses
- Secondary indexes
	- Case: used-car listings
	- Local
	  document-partitioned
		- Write: one shard
		- Read: scatter/gather all shards
		- Tail latency amplification
		- MongoDB, Cassandra, Elasticsearch
	- Global
	  term-partitioned
		- Index sharded by term
		- Read: one shard for postings
		- Write: many index shards
		- Multi-term AND is costly
		- DynamoDB: async, may be stale
		- CockroachDB, TiDB, YugabyteDB
	- DIY indexes risk inconsistency
