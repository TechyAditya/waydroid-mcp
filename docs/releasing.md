# Release a new version

The workflow `.github/workflows/publish.yml` publishes the package to npm when you push a tag that starts with `v`. npm records the commit and the workflow that built each version, and shows them on the package page as provenance.

## Set up publishing once

npm can't use trusted publishing for a package's first version, because the trusted publisher is a setting of a package that already exists. The first version needs an npm token. npm plans to stop tokens that bypass two-factor authentication from publishing directly in January 2027, as its [changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) says, so use the token only for this first version.

1. On npmjs.com, create a granular access token with read and write access to all packages, **Bypass two-factor authentication** selected, and a short expiry.
2. Add the token to the repository as the Actions secret `NPM_TOKEN`:

	```sh
	gh secret set NPM_TOKEN --repo TechyAditya/waydroid-mcp
	```

3. Publish the first version with the steps in [Publish a version](#publish-a-version).
4. On npmjs.com, open the package's **Settings**, and add a trusted publisher. Select **GitHub Actions**, then enter `TechyAditya` as the owner, `waydroid-mcp` as the repository and `publish.yml` as the workflow file.
5. Delete the secret, and then delete the token on npmjs.com:

	```sh
	gh secret delete NPM_TOKEN --repo TechyAditya/waydroid-mcp
	```

From then on, the workflow authenticates through trusted publishing, and the repository holds no npm token.

## Publish a version

1. Set the new version in `package.json`, and commit it:

	```sh
	npm version 0.2.0 --no-git-tag-version
	git commit -am "Release 0.2.0"
	```

2. Tag the commit with the same version, and push both:

	```sh
	git tag -a v0.2.0 -m "waydroid-mcp 0.2.0"
	git push origin main v0.2.0
	```

3. Watch the workflow run:

	```sh
	gh run watch --repo TechyAditya/waydroid-mcp
	```

If the tag and the version in `package.json` differ, the workflow stops before it publishes.
