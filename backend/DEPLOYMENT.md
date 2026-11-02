# Deployment record

Verified November 2, 2026, Asia/Seoul.

## Runtime

| Item | Value |
|---|---|
| Host | `utility-kr1`, Oracle Cloud, Chuncheon |
| Shape | ARM A1.Flex, 1 OCPU / 6 GB RAM |
| Address | `168.107.10.53` |
| Owner SSH | `ssh oracle`, or `ssh ubuntu@168.107.10.53` |
| Source | `/opt/kisj-menu/backend/` |
| Application source commit | `f309127` on branch `menu` |
| Container | `localhost/kisj-menu:current`, image prefix `90411b34b924` |
| Scheduler | `kisj-menu.timer`, hourly around minute 17 KST, up to 120 seconds jitter |
| Archives | `/var/lib/kisj-menu/menus/` |
| Firebase project | `kisj-grade-calculator` |
| Public collection | `cafeteriaMenus` |
| Private source cache | `cafeteriaMenuSources` |

The credential is stored separately under a root-protected directory and mounted
read-only. It is not part of the checkout or image.

## Verification

- 25 local tests pass.
- 30 Firebase Rules tests pass for anonymous users, students and admins.
- All six actual Korean/English attachments from HS posts 5149, 5151 and 5154 pass OCR.
- A real menu image converted to PDF passes the PDF rendering/OCR path.
- Cold OCR inside the deployed ARM container succeeds, exit 0, with no OOM event.
- A forced three-post run on the server publishes all three weeks, exit 0, zero failures.
- A subsequent systemd run skips all three unchanged sources and succeeds.
- Public menu read succeeds, public write is denied, and the source cache is private.

Published week IDs are `hs-2026-10-19`, `hs-2026-10-26`, and `hs-2026-11-09`.
The October 31 and November 1 closure is explicit in the October 26 week. No
November 2-8 menu was found in the currently exposed HS posts, so none was invented.

## Infrastructure changes

The previous AMD E2.1.Micro could not be resized. A new ARM utility instance was
created and `dns1` was reduced from 2 OCPU / 12 GB to 1 OCPU / 6 GB. Combined ARM
allocation remains 2 OCPU / 12 GB, and total boot/block storage is 197 GB.

During the DNS resize, the load balancer routed requests to `dns2`. After direct
DNS checks passed, `dns1` was restored to both backend sets. Both sets and the
load balancer were verified healthy after the old instance stopped.

The old micro instance at `168.107.1.236` is stopped, with its disk and reserved IP
retained for rollback. `ssh oracle-old` addresses it after an OCI start. Xray was
removed before shutdown; its root-only rollback archive is
`/root/rollback/xray-removal-20261102T114109Z.tar.gz` on that old disk.

## Friend SSH access

The account `hajun` uses the supplied Ed25519 public key and has a private home
directory plus `/home/hajun/projects/`. It has no sudo permission and cannot read
the scraper's Firebase credential. The server accepted the offered public key;
a complete login must be performed from Hajun's computer with his private key.

```sh
ssh hajun@168.107.10.53
```

The server's Ed25519 host fingerprint is
`SHA256:SbdTpIam+igZF8OXG2A0Tc7S5okThzv2xxc0HkkP4qo`.
