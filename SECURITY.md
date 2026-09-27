# Security policy

OpsDeck handles credentials (keyring, KeePass), kubeconfigs and access to infrastructure, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: repository → **Security** → **Report a vulnerability**. Include steps to reproduce, affected version/OS and the impact you see.

You will get a reply within a few days; fixes are released as a new version and credited in the release notes (unless you prefer otherwise).

## Scope

In scope: the OpsDeck application code in this repository (Rust backend, TypeScript UI, build workflow).
Out of scope: vulnerabilities in third-party services OpsDeck connects to (Grafana, Kubernetes, etc.) and in external tools it launches (kubectl, ssh, WinBox, …).

## Supported versions

Only the latest release receives security fixes.
