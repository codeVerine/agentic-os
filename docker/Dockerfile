ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim
ARG NODE_VERSION
ARG TARGETARCH

LABEL aos.npm-toolchain="linux-${TARGETARCH}-bookworm-node${NODE_VERSION}"

RUN test -n "$TARGETARCH"

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
    python3-venv \
    ripgrep \
    tmux \
    fonts-noto-cjk \
  && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
  && locale-gen \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN printf '%s\n' 'set -g default-terminal "screen-256color"' > /etc/tmux.conf

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# pre-commit is the one hook runner a container cannot install for itself: the agent user is not root and
# the base image has no pip. Projects whose hooks use it (`pre-commit install`) keep working in a session;
# husky and lefthook come from the project's own node_modules. The hook environments pre-commit builds are
# cached per project in a directory aos mounts at ~/.cache/pre-commit.
RUN python3 -m venv /opt/pre-commit \
  && /opt/pre-commit/bin/pip install --no-cache-dir pre-commit==4.7.0 \
  && ln -s /opt/pre-commit/bin/pre-commit /usr/local/bin/pre-commit

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.283 \
    @openai/codex@0.158.0 \
    opencode-ai@1.18.33 \
    @earendil-works/pi-coding-agent@0.87.1 \
  && npm cache clean --force

RUN npm install -g playwright@1.64.0 \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright playwright install --with-deps chromium \
  && ln -s "$(PLAYWRIGHT_BROWSERS_PATH=/opt/playwright node -e "console.log(require('/usr/local/lib/node_modules/playwright').chromium.executablePath())")" /usr/local/bin/aos-chromium \
  && chmod -R a+rX /opt/playwright \
  && rm -rf /var/lib/apt/lists/*

# Agents run with full autonomy by default: no approval prompts, no inner sandbox.
# The container is the sandbox. Codex's own bubblewrap sandbox could not create
# namespaces inside Docker anyway, so every command it ran would fail.
# /etc/codex/config.toml is Codex's lowest config layer: the user's
# ~/.codex/config.toml, -a, -s and /permissions override it. The other agents
# have no such layer, so aos fills their defaults into their own user config
# (secrets/<agent>/) at launch, see src/agents.ts.
RUN mkdir -p /etc/codex \
  && printf 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' > /etc/codex/config.toml

COPY codex-refresh.mjs aos-github.mjs /usr/local/lib/aos/

# GitHub access: git asks aos on the Mac for a one-repository token through this
# credential helper, and the gh wrapper does the same before running the real gh.
# Neither holds a credential; src/github.ts documents the channel.
COPY --chmod=755 gh-wrapper.sh /usr/local/bin/gh
# /mnt/aos-host-git is the read-only mount of the repository's own git directory, the session's `host` remote.
# Git's local transport drops the command-line safe.directory aos sets, and the mount root is not owned by the
# agent user, so the path is trusted here. The path is fixed, aos-owned and read-only.
RUN printf '[credential "https://github.com"]\n\thelper = !node /usr/local/lib/aos/aos-github.mjs credential\n\tuseHttpPath = true\n[safe]\n\tdirectory = /mnt/aos-host-git\n' > /etc/gitconfig

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
    /home/agent/.local/bin \
    /home/agent/.local/share \
    /home/agent/.local/share/aos-tools \
    /home/agent/.local/share/opencode \
    /home/agent/.local/state \
    /home/agent/.pi \
    /home/agent/.pi/agent \
    /home/agent/workspace

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    NPM_CONFIG_PREFIX=/home/agent/.local/share/aos-tools \
    PATH=/home/agent/.local/share/aos-tools/bin:/home/agent/.local/bin:$PATH \
    NO_MISTAKES_INSTALL_DIR=/home/agent/.local/share/aos-tools/bin \
    NO_MISTAKES_LINK_DIR=/home/agent/.local/share/aos-tools/bin \
    CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH=/usr/local/bin/aos-chromium \
    CHROME_DEVTOOLS_AXI_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage" \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    DISABLE_AUTOUPDATER=1

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
