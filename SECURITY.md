# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub: open the
[Security tab](https://github.com/emreerkan/polyglots/security) of this
repository and choose **Report a vulnerability**. Do not open a public issue
for them.

Say what an attacker could do, and how to reproduce it. You will get a reply
on the report, and a fix is released as a new version on npm.

## Supported versions

Only the latest release on npm gets fixes. Update with
`npm install -g polyglots@latest`.

## What is in scope

polyglots runs on your own machine. It reads and writes `.po` files, keeps a
translation memory and caches in `~/.local/share/polyglots/`, reads API keys
from `~/.config/polyglots/.env`, and sends text to the translation and review
providers you configure. A problem in any of these is in scope: for example a
crafted `.po` or TMX file that runs code or writes outside its folder, or a
key that ends up somewhere it should not.

The website at ada.tools/polyglots is static. A problem with the server that
hosts it is out of scope here.
