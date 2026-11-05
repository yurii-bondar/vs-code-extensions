# Accounts spike (step 11)

What the design map asked before building `45`–`48`: how to hand git a token while `GIT_TERMINAL_PROMPT=0` blocks prompts, and whether several GitHub accounts work on `engines.vscode` `^1.85`. Done 2026-11-05 with git 2.54 on macOS.

## Several GitHub accounts: needs VS Code 1.93

Checked in `@types/vscode`:

| Version | `authentication.getAccounts(providerId)` | `getSession(…, { account })` |
|---|---|---|
| 1.85 (Githor's engine now) | no | no |
| 1.88, 1.90, 1.92 | no | no |
| 1.93 and later | yes | yes |

On 1.85 the only lever is `clearSessionPreference` / `forceNewSession`, which makes VS Code ask the person to pick an account again. Githor could not list the accounts, nor ask for a session of a given one, so `45 Account menu` and `46 Manage accounts` cannot be built on it.

**Decision to take:** raise Githor's `engines.vscode` to `^1.93` and `@types/vscode` to `~1.93.0`. Githor has not been released, so nobody on an older VS Code loses it.

Built-in providers are `github` and `microsoft` (`github-enterprise` when that setting is on). GitLab, Bitbucket and others have no provider: their accounts are personal access tokens Githor stores itself, in `context.secrets`, never in settings or `globalState`.

## Handing git a token: an HTTP header through the environment

Two routes were tried:

1. **An inline credential helper** reading the token from an environment variable, after resetting the helper list with `-c credential.helper=`. **Rejected.** On this machine the reset did not keep out the system helper (`credential.helper osxkeychain` in `/opt/homebrew/etc/gitconfig`): with the reset and no helper of our own, git still answered with a token stored in the keychain. A helper of our own would be one voice among others, and git could push with another account's stored token.
2. **`http.<url>.extraHeader`** with `Authorization`, the way `actions/checkout` does it, passed through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0` (git 2.31+). **Chosen.** Verified, with fake values and no network:
   - the header applies to that URL only (`git config --get-urlmatch`): another host does not get it;
   - the value is in the environment of that one git process, not in its command line, so `ps` does not show it;
   - nothing is written to any config file.

   For GitHub the value is `AUTHORIZATION: basic <base64 of x-access-token:TOKEN>`.

What this needs in the code: `GitRunner.run` takes an optional `env` per call, and the operations that talk to a remote (fetch, pull, push, delete on origin) get the account's header.

**Not verified yet, needs a real remote:** that a push with the header succeeds; and what happens when the token is refused. A `401` makes git fall back to credential helpers, which could answer with another account's stored token; a `403` does not. Test both against a test repository with a throwaway token, with the person at the keyboard.

## SSH accounts and commit identity

- **SSH:** `core.sshCommand` = `ssh -i <key> -o IdentitiesOnly=yes`, through the same environment variables, per call. No secret: the key stays where it is.
- **Identity:** `-c user.name=… -c user.email=…` on the commit call (verified: `git var GIT_COMMITTER_IDENT` reads them, nothing written). The account's identity applies to Githor's commits; `48 Account states` warns when it differs from what the rules pick.

## Push rejected (`48`)

Recognise from git's stderr, not verified on a live remote:

- HTTPS: `The requested URL returned error: 403`, and GitHub's `remote: Permission to <owner>/<repo>.git denied to <user>.`
- SSH: `ERROR: Permission to <owner>/<repo>.git denied to <user>.`
- A private repository the account cannot see reads as `Repository not found.`

Which account has access: for GitHub, `GET /repos/{owner}/{repo}` with each account's token, then `permissions.push`. Ask only on a rejection, not on every push.

## Where things live

| What | Where |
|---|---|
| Tokens of token accounts | `context.secrets` |
| Account list (label, provider, user name, email, SSH key path) | `globalState` |
| Rules by remote URL | setting `githor.accounts.rules` |
| A repository's own choice | `workspaceState` |

Picking: the repository's choice, else the first rule matching the remote URL, else the last account used.

## Lesson for the tests

A probe of `git credential fill` against the real configuration printed a stored GitHub token. Tests and probes of credentials run with an isolated configuration (`HOME` set to a temp dir, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) and never print what a helper answers.
