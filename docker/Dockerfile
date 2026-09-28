FROM node:24.21.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap \
    build-essential \
    ca-certificates \
    curl \
    fd-find \
    git \
    jq \
    less \
    locales \
    openssh-client \
    procps \
    python3 \
    ripgrep \
  && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
  && locale-gen \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.283 \
    @openai/codex@0.158.0 \
    opencode-ai@1.18.33 \
    @earendil-works/pi-coding-agent@0.87.1 \
  && npm cache clean --force

# Codex's own bubblewrap sandbox cannot create namespaces inside Docker, so
# every command it ran would fail. The container is the sandbox; approvals stay
# on. The system config layer keeps ~/.codex/config.toml, -s and /permissions
# able to override this default.
RUN mkdir -p /etc/codex \
  && printf 'sandbox_mode = "danger-full-access"\n' > /etc/codex/config.toml

COPY codex-refresh.mjs /usr/local/lib/aos/codex-refresh.mjs

# Sandcastle's docker provider runs the container as --user <host uid>:<host gid>
# and refuses to start when the image user does not match, so the base image's
# "node" user is renamed to "agent" and moved to the host's UID/GID.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g "$AGENT_GID" node \
  && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node

# Agent state directories are bind-mounted from ~/AgenticOS/secrets at launch.
# Creating them here keeps Docker from creating their parents as root.
RUN install -d -o "$AGENT_UID" -g "$AGENT_GID" \
    /home/agent/.cache \
    /home/agent/.claude \
    /home/agent/.codex \
    /home/agent/.config \
    /home/agent/.config/opencode \
    /home/agent/.local \
    /home/agent/.local/share \
    /home/agent/.local/share/opencode \
    /home/agent/.local/state \
    /home/agent/.pi \
    /home/agent/.pi/agent \
    /home/agent/workspace

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PATH=/home/agent/.local/bin:$PATH

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
