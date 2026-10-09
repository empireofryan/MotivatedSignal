# MotivatedSignal

Maricopa County distressed-seller data platform. See `CLAUDE.md` for the full project brief
(stack, data model, status) — decrypt it first if you're on a fresh clone; see below.

## Private files

A few planning docs are committed encrypted (`.age`) instead of in plaintext, because this repo
is public:

- `CLAUDE.md.age`
- `docs/outreach-plan.md.age`
- `docs/competitors.md.age`

The plaintext versions (`CLAUDE.md`, `docs/outreach-plan.md`, `docs/competitors.md`) are
gitignored and only ever live on disk locally.

**Decrypt** (after cloning, or to read the latest):
```
scripts/secrets.sh decrypt
```
Requires the private key at `~/.config/motivatedsignal/age.key`. Without that key these files
cannot be read — there is no recovery path, so the key is backed up outside this repo.

**Encrypt** (after editing a plaintext copy, before committing):
```
scripts/secrets.sh encrypt
```
This regenerates the `.age` files from the current plaintext using the project's `age` public key.

Public mirror of this project; full history lives in the private archive repo.
