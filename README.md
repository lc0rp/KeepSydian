# KeepSydian: 2-way Obsidian-Google Keep sync

[![License](https://img.shields.io/github/license/lc0rp/KeepSydian?style=flat-square)](LICENSE)
[![Issues](https://img.shields.io/github/issues/lc0rp/KeepSydian?style=flat-square)](https://github.com/lc0rp/KeepSydian/issues)
[![Release](https://img.shields.io/github/v/release/lc0rp/KeepSydian?style=flat-square)](https://github.com/lc0rp/KeepSydian/releases)
[![Downloads](https://img.shields.io/github/downloads/lc0rp/KeepSydian/total?style=flat-square)](https://github.com/lc0rp/KeepSydian/releases)

## Why the name change? What happened to 'KeepSidian'?

**Different name, same value.**

The new Obsidian plugin guidelines prohibit use of '-sidian' in plugin names. 
So we've updated the name to allow the
plugin is listed in the official Obsidian plugin directory. 
We chose the closest name to the original to minimize
confusion.

## What is KeepSydian?

As a regular user of both Google Keep and Obsidian, I set out to make it easier 
to exchange data between both apps.

KeepSydian syncs notes between Google Keep and Obsidian, on demand or automatically 
on a schedule. The KeepSydian Sync Center lets you  select options, and 
then review a download, upload, or two-way plan before any changes are made to your vault or in Google Keep.

- Versions 1.1.2+: Introducing two-way sync!
- Versions 1.1.1 and below: Only downloading supported

Please share your feedback in the [issues section](https://github.com/lc0rp/KeepSydian/issues) on GitHub.

## KIM based sync server

The connection to Google Keep is established through a flask server based on
[Keep-It-Markdown](https://github.com/djsudduth/keep-it-markdown), which handles the heavy lifting. This is particularly
useful for users who cannot run Python scripts on their computers.

When you start a sync, you will provide your Google Keep email and a token generated during installation. These
credentials are stored on your computer, sent when you sync, and then discarded. KeepSydian stores sync tokens in
Obsidian secret storage when available, and does not log or store your credentials or notes on the server.

## Manual sync and the Sync Center

KeepSydian now triggers manual sync using one primary command: **Sync now**.

- `Sync now` opens the Sync Center and immediately starts building a reviewable download plan.
- `Open sync center` opens the Sync Center but doesn't start a sync, so you can choose the mode first.
- The ribbon icon and status-bar item also open the Sync Center.
- The Sync Center can build plans for **Download**, **Upload**, or **Two-way sync**.
- Download plans support three start-date scopes:
  - `Last successful sync`
  - `All dates`
  - `Custom`
- Two-way sync uses two staged reviews: first the download plan, then the upload plan created from the updated local
  state.
- Legacy commands for **Perform two-way sync**, **Download notes from Google Keep**, and **Upload notes to Google Keep**
  still exist, but they now route into the same Sync Center flow.

Every manual sync starts with a review. KeepSydian builds a plan, then a review page shows counts grouped by note status/action, and and the exact notes/actions before execution. While a sync is running, the status bar, notices, and review page stay in sync so you can track progress from either place.

## Activity log (v1.1.0+)

Each sync activitiy is recorded in a time stamped activity log file under `_KeepSydianLogs/` in the target directory as
Markdown list items. This file is rotated daily.

## Background sync (v1.0.7+)

You can enable background syncing on a 24 hour schedule by default. Project supporters can customize the interval in
hours. Project supporters can also choose to run a two-way sync whenever background syncing.

When background-sync is enabled, a status bar indicator is shown in the bottom right.

## Supporting the project

KeepSydian is useful for all users. However, some advanced features that may incur additional processing, third party
costs or developer time shall be released to users who choose to support KeepSydian development. Anyone can choose to
support the project here:
[🌎 Support KeepSydian](https://keepsidianserver-v2-162887264002.us-central1.run.app/subscribe).

### Exclusive supporter features

v1.0.14:

- Advanced filters
- Auto-tagging
- Contextual title generation

v1.1.0:

- Granular background sync interval below the default 24 hours.

v1.1.2:

- Two-way background sync

Active supporters can manage billing or unsubscribe from inside Obsidian. Open
`Settings > KeepSydian > Exclusive features for project supporters`, then use the Stripe customer-portal link shown in
the active subscription section.

## Future roadmap

Some upcoming features that I plan to work on include:

- Daily sync (Shipped in v1.1.0)
- Realtime sync
- Archiving
- Downloading Archived Notes
- Unlimited notes (Shipped in v1.0.14)
- 2-way sync (Shipped in v1.1.2)
- Advanced filters (Shipped in v1.0.14 to supporters)
- Auto-tagging (Shipped in v1.0.14 to supporters)
- Contextual title generation (Shipped in v1.0.14 to supporters)

> **What would you like to see next?**
>
> Please rank the upcoming features here or add your own!
>
> 1. [KeepSydian wishlist](https://umh39lhux3j.typeform.com/to/NKbRukRg) - Google keep features.
> 2. [Google Calendar features](https://umh39lhux3j.typeform.com/to/WuDedfWN) (coming soon): I'd love to hear what you
>    want for this feature.

## Installation

KeepSydian can be installed from the [community plugin store](https://obsidian.md/plugins?id=keepsidian), as well as a
few other options outlined below.

### Get the plugin

- **Option 1 (Preferred)**: Via the [Obsidian community plugin store](https://obsidian.md/plugins?id=keepsidian)
- **Option 2**: Use the [Obsidian BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
- **Option 3**: Clone this repository in your {obsidian vault path}/.obsidian/plugins

After installation, go to "Settings > Community Plugins > KeepSydian" in Obsidian to configure the plugin.

### Configure

In the plugin settings, you will need to provide:

- Enter your Google Keep email.
- Choose a save location in your vault. New installs default to `/KeepSydian`.
- Optionally customize the save-location pattern with `{now.*}` and `{note.*}` variables such as year, month, day, or
  date.
- Optionally customize the imported note filename pattern. The default is `{title}`.
- Enable/disable automatic syncing.

### Retrieve a Google Keep token

- Desktop: use **Retrieve token with helper** for the guided flow. The first launch asks before downloading the
  open-source KeepSidian token helper from GitHub releases; later launches reuse the installed helper unless an update
  is required. You can still follow the manual KIM instructions and paste the token yourself.
- Mobile: the retrieval wizard is hidden. Paste a token captured on desktop, or paste a short-lived `oauth2_4...` token
  and let KeepSydian exchange it through the server.

**PRIVACY NOTE**: THIS TOKEN IS ONLY STORED ON YOUR COMPUTER. When supported by your Obsidian version, KeepSydian stores
the token in Obsidian secret storage.

## Mobile compatibility (v2.0.3+)

Starting with v2.0.3, KeepSydian can be used on mobile. A community member takes Google Keep notes on the go from their
smartwatch, then uses KeepSydian on their phone to sync those notes into Obsidian.

KeepSydian on mobile still requires a sync token, but it does not include the token retrieval wizard. The easiest path
is to retrieve the token on desktop, copy it, paste it into a temporary Google Keep note, then open that note on your
phone and copy/paste the token into KeepSydian settings. Any other reliable copy/paste method between desktop and phone
works too.

## Frontmatter

The plugin adds the following frontmatter to each synced note:

- GoogleKeepUrl
- GoogleKeepCreatedDate
- GoogleKeepUpdatedDate
- KeepSydianLastSyncedDate

## Conflict resolution

When a local note and its Google Keep counterpart have both been modified since the last sync, KeepSydian now attempts
to merge the differing bodies of the notes. The frontmatter of the existing note is preserved and excluded from the
merge comparison. If the merge succeeds, the note is updated in place; otherwise, the incoming version is saved as a
separate `-conflict-<timestamp>.md` file.

## Attachments

- Downloaded attachments are stored under the sync folder's `media/` directory.
- **Display imported images in notes** is disabled by default. Enable it in KeepSydian settings to append Obsidian image
  embeds to imported notes while keeping the image files in `media/`.
- Upload scans Markdown notes under the save location and includes referenced attachments that resolve into `media/`.
- Missing attachments are skipped and recorded in the sync log.
- Media uploads are still considered experimental and server support may vary by attachment type.

## Other plugins

- [Obsidian Task Roles](https://github.com/lc0rp/obsidian-task-roles/) - Assignee & Role Tracking for your Obsidian
  Tasks.
- [Checkbox Bulk Dates](https://github.com/lc0rp/obsidian-checkbox-bulk-dates) - Add creation dates to unchecked
  checkboxes.

## Feedback

Please share your feedback in the [issues section](https://github.com/lc0rp/KeepSydian/issues) on GitHub.
