# Release a new version

The workflow `.github/workflows/publish.yml` publishes the package to npm when you push a tag that starts with `v`. npm records the commit and the workflow that built each version, and shows them on the package page as provenance.

The workflow authenticates through npm's trusted publishing, so no npm token exists anywhere. On npmjs.com, the package's **Settings** list `TechyAditya/waydroid-mcp` and `publish.yml` as the trusted publisher, with `npm publish` allowed. If you rename the workflow file, update the trusted publisher to match, or publishing fails.

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

If the tag and the version in `package.json` differ, the workflow stops before it publishes. A new version can take about two minutes after the run to show up with `npm view waydroid-mcp`.

## How the package was first published

npm can't use trusted publishing for a package that doesn't exist yet. So `0.0.0`, a stub with no code, was published by hand to create the package, and then the trusted publisher was added. Version 0.1.0 was the first that the workflow published. `0.0.0` is deprecated.
