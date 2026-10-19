# Isolation and actual results

2026-10-19 · Container isolation proposal, deferred by the user. The current implementation target is explicit local Codex execution; see [local mode](local-execution.md). The container ownership, network enforcement and reconciliation design below is retained for a later slice and is not implemented.

This covers items 3 and 4 of the next-stage recommendation: verify isolation, and preserve actual commands, logs, code changes and failures. Implement them together: stopping an Environment must not erase the information needed to understand its Run.

## Starting point

The TUI currently controls trusted ACP fixtures. The real-provider launcher in `src/execution/internal/worker.ts` proposes private containers and networks, a non-root user, read-only root filesystem and resource limits. Those settings have not been validated on a real worker.

Three gaps drive this plan:

- `/workspace` is currently tmpfs. Stopping its container loses that workspace, so exporting after cancellation cannot work with the current storage layout. [Docker tmpfs lifecycle](https://docs.docker.com/engine/storage/tmpfs/)
- Resource ownership and events exist only in memory. A timeout after Docker creates a resource, but before the caller receives confirmation, can leave resources outside the launcher's cleanup flags.
- ACP tool status and agent messages are reported activity. The current events do not establish every command's actual exit code, or preserve a trustworthy final code snapshot.

## Scope and deployment assumption

Start with one configured project, one provider and a dedicated Linux worker reached through SSH. Keep the existing local daemon for this slice; moving the daemon onto the worker remains separate work. The implementation stays TypeScript + Node.js.

The agent gets a worker-side code copy, private CLI home, temporary files and network. The user's source checkout, CLI configuration, SSH agent and Docker socket are never mounted into its container. The workbench may save its own catalog and artifacts on the daemon host; that directory is not exposed to agents.

The worker and its container engine are trusted infrastructure. Use a dedicated VM if sharing the host with unrelated sensitive workloads would violate that assumption. This acceptance verifies the configured controls; it does not establish immunity to container-engine or kernel vulnerabilities.

## 3. Isolation and cleanup

### Own every resource durably

Before creating a container, network or workspace, record its intended identity and owning installation/Run in SQLite. Apply the same ownership labels to Docker resources. After an uncertain response, reconcile the intended resource rather than assuming creation failed.

Keep one controller per worker initially. Cleanup is idempotent and deletes only resources whose identity and ownership match the catalog. Never use a machine-wide prune. Record lifecycle and cleanup status independently: a Run can be interrupted while cleanup is still unconfirmed.

On daemon restart, invalidate old approval callbacks, mark disconnected executions interrupted and reconcile owned resources. Saved history does not restore a live ACP session. If the worker is unreachable, show `Cleanup unconfirmed` and retry when it becomes reachable. A local daemon cannot guarantee remote deletion while disconnected.

### Preserve code outside the agent's lifetime

Replace workspace tmpfs with a Run-private named volume on the worker. Keep CLI home and temporary files ephemeral. Named volumes survive container removal, so cleanup must explicitly remove each owned volume after capture. [Docker volume lifecycle](https://docs.docker.com/engine/storage/volumes/)

When finalizing a Run:

1. Reject further prompts and invalidate pending approvals.
2. Stop the agent container and confirm its writers and descendants are gone.
3. Mount its workspace read-only in a trusted exporter, with no provider credentials or network, and capture the code.
4. Persist the Candidate, diff and available Run records outside the agent Environment.
5. Remove owned compute, network and workspace resources, then query the worker to confirm absence.

An ordinary agent turn ending does not automatically finalize its Run. Finalization is an explicit operation; cancellation uses the same stop-and-capture path but creates an interrupted result, never a passing verification.

Cancellation must stop work before attempting export. Give export a bounded deadline and byte limit. If capture fails, remove agent compute/network immediately and retain only the inaccessible-to-agents workspace volume for a bounded recovery window. Mark capture incomplete and cleanup outstanding. Retry capture, or explicitly discard the retained workspace; expire it under the configured retention policy. Record expiry as data loss, not successful capture. A quota must prevent retained volumes from growing without bound.

### Verify network and process controls

A private Docker bridge does not mean outbound traffic is denied; bridge networking normally enables external connectivity. Enforce an explicit worker-side egress policy that permits required provider/package endpoints and denies other destinations, including management interfaces and other Runs. Agents cannot change that policy. [Docker bridge networking](https://docs.docker.com/engine/network/drivers/bridge/)

Inspect effective mounts, user, capabilities and resource limits on the selected worker. Test them with a deterministic probe before connecting a model. No published service ports in this slice; service previews need their own later policy.

### Concrete Implementation for item 3

Keep this inside the existing `execution` Module. Proposed file responsibilities:

| File | Implementation responsibility |
| --- | --- |
| `index.ts` | Existing high-level Run Interface; expose cleanup progress separately from the Run outcome. |
| `internal/runtime.ts` | Serialize start/cancel/finalize for each Run, reject new work after stopping begins and invalidate decision callbacks. |
| `internal/worker.ts` | Create, inspect, stop and remove Docker resources through the existing Docker/SSH transport. Keep command arguments and resource handles private. |
| `internal/journal.ts` (new) | Persist desired Run state and resource creation/deletion intent in SQLite. |
| `internal/reconcile.ts` (new) | Compare the journal with actual worker resources after uncertain operations and daemon restart. |

The resource journal needs an operation ID, installation ID, Run ID, worker ID, resource kind/purpose, intended name, observed Docker ID, desired state, last confirmed state and safe failure details. Do not store credentials. Include initialization/export helpers and any per-Run proxy resources, not just the agent container. A daemon-host process lock protects the catalog; the first slice supports only that single controller managing a worker.

Launch order:

1. Validate the source revision, immutable image identity and worker policy; record a Run with desired state `running`.
2. Record each resource intent before issuing its Docker command. Create a private workspace volume and network with installation/Run/purpose labels. After a timeout, inspect the intended name and adopt it only when identity, labels and configuration match. Conflicts stop launch.
3. Populate the workspace at the pinned base SHA using a tracked initializer. Give the agent a non-root-writable workspace, fresh ephemeral home/tmp and only its selected provider/profile configuration. Skills/plugins come from pinned worker assets or a Run-local copy.
4. Create the agent container, inspect its configuration, then start it and attach ACP through `docker exec` over SSH. Require a read-only root filesystem, dropped capabilities, no privilege escalation, normal syscall confinement and configured CPU/memory/PID limits. Require an enforced workspace storage quota as a worker capability; do not infer it from the volume name or memory limit. Never attach host namespaces, host source/home, management sockets or an SSH agent.
5. Publish the ready state only after initialization and policy checks succeed. Filesystem/terminal ACP callbacks remain disabled until their Implementation routes exclusively into this Environment.

For the first worker, pin the supported Docker firewall backend. Use a per-Run internal bridge with an explicitly managed egress proxy. Block container-to-host management traffic with host input policy, and deny direct external/cross-Run paths using supported additive firewall hooks. With the iptables backend, Docker provides `DOCKER-USER` for additional forwarding policy; leave Docker-generated chains intact. Proxy configuration alone does not enforce the policy. Test that direct connections fail and approved proxied requests succeed; verify the selected adapter supports this route before claiming live-provider isolation. [Docker firewall integration](https://docs.docker.com/engine/network/firewall-iptables/)

Internal networks can still reach appropriately bound host services at their gateway, so `--internal` by itself does not satisfy the host-management restriction. [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal)

Cancellation records desired state `stopped`, invalidates approvals and closes new input before performing worker operations. Stop the whole agent container with a bounded grace period, inspect that it is stopped, capture the workspace, then delete the owned resources. Do not treat killing the local SSH process as proof that remote work stopped. Docker stop supports a grace period followed by forced termination; the subsequent inspection establishes the observed state. [Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)

After restart, reconciliation uses the same desired-state logic to stop interrupted Runs and finish pending cleanup. Missing resource, denied inspection and unreachable worker are distinct outcomes. Public cleanup status should distinguish pending, confirmed complete, retained workspace after capture failure and unconfirmed worker state. The TUI reads that status; it never performs reconciliation itself.

## 4. Actual results

### Keep observation separate from claims

Preserve agent narrative and ACP activity as provider-reported records. Use a workbench-controlled runner in a fresh Environment for authoritative checks. It executes project-configured commands and observes their process outcome; it does not accept an agent's statement that tests passed as a replacement.

This captures the checks the runner executes. It does not promise a complete audit of every command hidden inside a provider adapter. Existing raw adapter/login stderr remains excluded; save sanitized lifecycle diagnostics instead.

### Seal the code before checking it

The exporter captures the stopped workspace's tracked changes, deletions and intended new files relative to the configured base SHA. Derive the base and tracked path set from a trusted repository, not the agent's mutable `.git` metadata. Use trusted Git configuration and tooling, without running agent-controlled hooks or filters. Handle symlinks and paths without following them outside the source tree. Exclude dependency caches and configured secret/generated paths, and list omissions explicitly. Unsupported submodules or LFS content must be reported as incomplete until capture can reproduce them.

Create a canonical Candidate commit and preserve enough Git objects/bundle data to reconstruct it. Compute the final diff from that captured version, rather than relying on provider diff notifications. Candidate identity and artifact checksums must be recorded before workspace deletion.

Run checks in a fresh checkout of this Candidate, with separate home, workspace and network and no model credentials. Check configuration comes from the controller's project settings, not an unreviewed edit by the agent. Dependency preparation is also recorded. Checks that change versioned source cannot silently redefine the Candidate: return the changes to Dev, create a new Candidate and rerun.

### Save one structured record per check

| Record | Required contents |
| --- | --- |
| Identity | Run/check ID, base and Candidate SHA, project check configuration revision; Task spec revision once Tasks exist |
| Environment | Resolved image digest, relevant tool versions and safe configuration identifiers; no credential values |
| Invocation | Actual executable/arguments with secret values redacted, working directory, start/end timestamps and duration |
| Outcome | Completed with exit code/signal, timed out, cancelled, launch failure or lost/unknown outcome |
| Output | Separate stdout/stderr artifact references, byte counts, checksums and explicit truncation/incomplete flags |

Stream output to bounded artifact files rather than collecting it in memory. Finalize a successful capture only after the process and output streams close and the files are committed to storage. Node's `exit` event alone does not establish that stdout/stderr are closed. [Node child-process lifecycle](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#event-close)

Keep artifact storage private and outside agent mounts. Checks reference secrets through configuration rather than embedding values in command arguments. Filter known injected secrets and avoid collecting credential files; logs remain private because arbitrary project output can contain sensitive information. Storage exhaustion, truncation and transport loss must produce explicit partial records. Read artifacts by opaque ID and render logs as text with terminal control sequences neutralized.

An exit code of zero means that command succeeded. It does not establish that every acceptance condition was covered. Preserve missing/skipped checks and bind all results to their Candidate and configuration revisions. Changed code/spec/configuration makes affected results stale; the UI cannot override that with a boolean.

## Module ownership and Interface

| Module | Responsibility in this slice |
| --- | --- |
| `execution` | Own environment lifecycle, durable resource intent, process observation, trusted export and raw Run records. Hide Docker/SSH IDs, deadlines, cleanup ordering and reconciliation. |
| `attention` | Own decision validity and delivery state. Invalidate approval requests when their Run stops. Cleanup failures are not provider permission requests. |
| `evidence` | Own canonical Candidate identity, durable Artifacts and check-result applicability. Introduce this Module when actual capture lands, with real ingest/query behavior. Full Task acceptance evaluation follows the Task workflow. |
| `app` | Wire dependencies and render public summaries/artifacts. No Docker commands, storage queries or verification rules in TUI handlers. |

Keep `start`, `prompt`, `cancel` and event observation as high-level operations. Add only the operations required to finalize a Run, execute a configured check profile and read saved artifacts. Finalization handles stop, capture and cleanup internally; callers do not coordinate those steps.

Wire `execution` to the required public recording Interface of `evidence` at composition time. `evidence` does not call back into `execution`. Successful capture is acknowledged before deletion; retrying after a crash must not duplicate a Candidate or result. Each Module owns its own stored records through its Implementation; no cross-domain table access or generic storage framework.

TUI presentation stays compact: lifecycle/cleanup status and check counts in the existing view, check events in Timeline, actual captured code in Diff, and selectable logs in the existing detail area. No separate diagnostics dashboard. Clearly distinguish `Passed`, `Failed`, `Incomplete` and `Stale`.

## Delivery sequence

| Slice | Deliverable | Exit condition |
| --- | --- | --- |
| A — Lifecycle | Minimal SQLite resource journal, private workspace volume, ownership checks and restart reconciliation | Creation-response loss, repeated cancel and daemon restart leave no untracked owned resources; unavailable worker stays unconfirmed. Confirm Node/SQLite driver compatibility first. |
| B — Observed checks | Trusted runner, bounded streaming stdout/stderr and durable outcome records | Exit, signal, timeout, large output, disk failure and transport loss are represented accurately and remain readable after restart. |
| C — Candidate and artifacts | Trusted export, minimal `evidence` Module, fresh verification checkout and actual diff | Rebuild the exact Candidate and read its results after deleting the original Environment; changed versions cannot reuse a passing result. |
| D — Acceptance and TUI | Deterministic isolation probes, failure injection, compact summaries, then one real-provider smoke | All acceptance cases below pass on the selected worker; fixture success alone does not establish provider support. |

## Acceptance cases

- Compare the local source checkout and explicitly selected configuration fingerprints before/after. Do not scan or retain credential contents.
- Run A can write its own files; Run B cannot read them, access A's home/processes or reach forbidden endpoints. Failed/cancelled A does not stop B.
- Root filesystem writes and Docker/control-socket access fail; effective limits constrain the probe as configured.
- Cancel with a child and grandchild running. Confirm their container stops and that only owned resources are removed. Repeated cancellation is safe.
- Inject failure after each resource creation, including lost creation responses. Kill/restart the controller and disconnect the worker; no stale approval remains actionable and no unknown cleanup becomes `Cleaned`.
- Exercise passing/failing commands, timeout, cancellation, launch failure, partial logs and output limits. Stored status matches observed outcome.
- Capture code additions/deletions and a failed check; delete the Environment, restart the daemon, reconstruct the Candidate and reopen diff/logs.
- Force export/storage failure. Work stops, partial capture is visible, retained workspace is accounted for, and retry/expiry follows policy.
- Change Candidate or check configuration and confirm the previous result cannot satisfy the new version. When Task specs land, repeat for spec revision.

When container work resumes, start with Slice A. Select the worker, first repository and check profile before live acceptance; settle capture limits and retention defaults against that repository. Current work proceeds with explicit local execution and then actual result capture. This plan does not start the role pipeline, Services or PR publication.
