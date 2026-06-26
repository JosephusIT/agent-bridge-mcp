class AgentBridgeMcp < Formula
  # WORK IN PROGRESS — not installable yet.
  # The 0.3.0 tarball must be published to npm and the placeholder `sha256` below
  # replaced with the real tarball checksum before `brew install` will succeed.
  # Until then this formula is a template only.
  desc "Model Context Protocol server for AgentBridge sessions"
  homepage "https://github.com/JosephusIT/agent-bridge-mcp"
  url "https://registry.npmjs.org/@junctum/agent-bridge-mcp/-/agent-bridge-mcp-0.3.0.tgz"
  sha256 "REPLACE_WITH_NPM_TARBALL_SHA256"
  license :cannot_represent

  depends_on "node"

  def install
    libexec.install Dir["*"]

    (bin/"agentbridge-mcp-server").write <<~EOS
      #!/bin/bash
      exec #{Formula["node"].opt_bin}/node #{libexec}/dist/index.js "$@"
    EOS

    (bin/"agentbridge-listen").write <<~EOS
      #!/bin/bash
      exec #{Formula["node"].opt_bin}/node #{libexec}/dist/listen.js "$@"
    EOS

    (bin/"agentbridge-setup").write <<~EOS
      #!/bin/bash
      exec #{Formula["node"].opt_bin}/node #{libexec}/dist/setup.js "$@"
    EOS

    (bin/"agentbridge-worker").write <<~EOS
      #!/bin/bash
      exec #{Formula["node"].opt_bin}/node #{libexec}/dist/worker.js "$@"
    EOS
  end

  test do
    assert_match "agentbridge", shell_output("#{bin}/agentbridge-setup --host generic --print-config")
  end
end
