FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @agentclientprotocol/codex-acp@2.2.2 @agentclientprotocol/claude-agent-acp@0.93.0
COPY fixtures/project /opt/workbench-fixture
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
