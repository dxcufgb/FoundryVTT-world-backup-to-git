# Foundry world backup

[![Latest release](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-world-backup-to-git?label=release&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dxcufgb/FoundryVTT-world-backup-to-git/total?label=downloads&color=blue)](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/releases)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/dxcufgb)\
[![CI](https://img.shields.io/github/actions/workflow/status/dxcufgb/FoundryVTT-world-backup-to-git/ci.yml?branch=main&label=CI)](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/dxcufgb/FoundryVTT-world-backup-to-git)](LICENSE)

<a href="https://dxcufgb.github.io/FVTT-dev-showcase/"><img src="https://dxcufgb.github.io/FVTT-dev-showcase/assets/img/workshop-badge.png" alt="Dxcufgb's Workshop: every Foundry VTT project, video and changelog in one place" width="650"></a>

A small service that lives next to a self-hosted **Foundry VTT** server and backs every **world** up to its own
**private GitHub repository** on a schedule. Each run is a git commit of the world folder (the files in
`Data/worlds/<world id>`: `world.json`, the LevelDB packs, scenes, uploaded assets…) pushed to GitHub, so the full
history of every world is kept and any state can be restored with `git`. Node.js only, no npm dependencies; the
backups are made with the `git` command. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a scheduled
task on Windows, and can optionally keep itself up to date from this repository's releases.

A password-protected **administration page** on port **8484** (HTTPS) lists the worlds of the Foundry server with
whether each one is backed up, when it was last backed up and the size of its folder, with a cogwheel per world for
its own settings (on/off, repository name, its own schedule, what to do while the world is active in Foundry). The
page also holds the global schedule, the GitHub token, the notification e-mail settings and the admin password, and
starts a backup by hand. When a backup fails (GitHub refuses the token, a push is rejected, the folder cannot be
read…) a warning e-mail goes to the configured addresses, and one more says when the world backs up again.

## Installation

First [create the GitHub token](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Create-the-GitHub-Token).

Linux (Raspberry Pi):

```sh
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-world-backup
```

Windows: run `foundry-world-backup-X.Y.Z-setup.exe` from the [latest release](../../releases/latest).

Prerequisites, installer options, silent installs and everything else:
[Install on Linux](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Install-on-Linux) and
[Install on Windows](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Install-on-Windows).

## Documentation

The full guide is in the [wiki](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki):

- [Create the GitHub Token](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Create-the-GitHub-Token): the narrow fine-grained token and GitHub's size limits
- [Install on Linux](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Install-on-Linux) and [Install on Windows](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Install-on-Windows): installers, options, file layout
- [Admin Page](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Admin-Page): the Worlds table and the settings pages
- [Trusting the Certificate](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Trusting-the-Certificate): so the browser saves the admin password
- [How a Backup Works](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/How-a-Backup-Works)
- [Restoring a World](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Restoring-a-World)
- [Installable World Backups](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Installable-World-Backups): install a backed-up world in Foundry
- [Notifications and Daily Check](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Notifications-and-Daily-Check)
- [Automatic Updates](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Automatic-Updates)
- [Configuration Reference](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Configuration-Reference): `config.json` and the environment variables
- [Admin Page on a Public Address](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Admin-Page-on-a-Public-Address) and [Admin API](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Admin-API)
- [Troubleshooting](https://github.com/dxcufgb/FoundryVTT-world-backup-to-git/wiki/Troubleshooting)

## License

[MIT](LICENSE) © 2026 Dxcufgb.
