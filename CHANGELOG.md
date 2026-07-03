# Changelog

## [1.0.0](https://github.com/martadams89/seo-website-indexer/compare/v0.9.0...v1.0.0) (2026-07-03)


### ✨ Features

* add configurable GSC URL inspection limit override to scheduler options ([b9ed608](https://github.com/martadams89/seo-website-indexer/commit/b9ed6084a65fe26be770154d34362fd9eef21e3a))
* add helpful error guidance for Google Cloud OAuth client type configuration in setup page ([ed35eb8](https://github.com/martadams89/seo-website-indexer/commit/ed35eb8e9d15e14e83b7b2ecbda75aa902ffef21))
* add info tooltip to Google Index State header in Sites table ([fd47fd4](https://github.com/martadams89/seo-website-indexer/commit/fd47fd429d02e64ac4fa23eb9a05d8c293dcf2fd))
* add quota widget and toast notifications; enhance logs page with search and virtualization ([41454ed](https://github.com/martadams89/seo-website-indexer/commit/41454edf9560f5dfb0fdde3fdc32b8dd0c2bcb4e))
* add release lock functionality to dashboard with user confirmation and error handling ([895e45a](https://github.com/martadams89/seo-website-indexer/commit/895e45ab6a044712cc37b829fa4d74d9a3653b2a))
* add support for multi-account Google authentication and site association via new database schema ([ffb4aa4](https://github.com/martadams89/seo-website-indexer/commit/ffb4aa4808d307320ca0e965f66dee4ac26eb2d8))
* add userinfo.email scope to Google OAuth flow ([fe2dc68](https://github.com/martadams89/seo-website-indexer/commit/fe2dc685ee7eae783de397f666ee3fc90b72fb66))
* add workflow_dispatch trigger to docker-publish workflow ([153c276](https://github.com/martadams89/seo-website-indexer/commit/153c276e333195fd5666a652ed595dba104a282b))
* analytics engine, dashboards, AI citation tracking, Bing API, llms.txt lifecycle, CrUX, alerts + notifications ([4cd3895](https://github.com/martadams89/seo-website-indexer/commit/4cd3895f4c6929cc2183c198e7f82038799af65b))
* Bing Webmaster URL Submission + robots.txt sitemap discovery (llms-sitemap → IndexNow) ([c12be8d](https://github.com/martadams89/seo-website-indexer/commit/c12be8d6753050c3dda4fe3061f004fd7a124046))
* Bing Webmaster URL Submission + robots.txt sitemap discovery (llms-sitemap → IndexNow) ([53ccf1b](https://github.com/martadams89/seo-website-indexer/commit/53ccf1bd58969280fabbd02a393576fb294a303c))
* Brave Search as a zero-cost citation provider (retrieval-layer presence) ([8e825c0](https://github.com/martadams89/seo-website-indexer/commit/8e825c0511e965ebe3125b136899e5712c827a45))
* **ci:** self-hosted Renovate workflow replaces the GitHub App ([9244f66](https://github.com/martadams89/seo-website-indexer/commit/9244f661edeff570936fe35622aab176b5ce4264))
* enhance mobile UI with improved touch targets, icon buttons, and responsive design ([e17fea9](https://github.com/martadams89/seo-website-indexer/commit/e17fea9f030b272e00c6cca45739e16a40550398))
* expand Google indexing status, update docs ([67b4322](https://github.com/martadams89/seo-website-indexer/commit/67b43222d645724bc2de51e60bdc0ab4e2208029))
* implement backfill for orphan site accounts and add fallback warnings in scheduler ([3ed1a5a](https://github.com/martadams89/seo-website-indexer/commit/3ed1a5aec48807d8f87cbe32fac083d1ac45594a))
* migrate Google OAuth from device flow to web application flow with popup authentication ([ea21b44](https://github.com/martadams89/seo-website-indexer/commit/ea21b446ad633ae28c5afd05d099acc4a643ad68))
* mobile-responsive UI with collapsible sidebar and modern tooltips ([64204a4](https://github.com/martadams89/seo-website-indexer/commit/64204a4d1f797cf40c3c038841ef38428e84c0f6))
* one-click Gemini key provisioning via the linked Google account ([46d9b87](https://github.com/martadams89/seo-website-indexer/commit/46d9b87c694f178f73e81396ade8c959f37996c7))
* self-maintaining release pipeline — release-please, Renovate auto-merge, unit tests, community docs ([c83dea0](https://github.com/martadams89/seo-website-indexer/commit/c83dea0c1a817ef8c3187f5333a25b7538e51836))


### 🐛 Bug Fixes

* **auth:** stop INSERT OR REPLACE from unlinking sites on every token refresh ([c3a0f39](https://github.com/martadams89/seo-website-indexer/commit/c3a0f39724e0bb1fc271c19141b745489ab072de))
* correct FRONTEND_DIST path and add entrypoint for /data permissions ([5a3c04e](https://github.com/martadams89/seo-website-indexer/commit/5a3c04e30b82f97476b488d9557afa086a5126fa))
* **deps:** update npm dependencies (non-major) ([#21](https://github.com/martadams89/seo-website-indexer/issues/21)) ([3c4394e](https://github.com/martadams89/seo-website-indexer/commit/3c4394efa5946e3fd587dc097addde8d3b693c58))
* enable reply.sendFile by removing decorateReply: false ([783d968](https://github.com/martadams89/seo-website-indexer/commit/783d9689a241f4d689f6f7cad8c6d717782d9c4c))
* handle Google OAuth profile retrieval errors when user data is incomplete ([c74136a](https://github.com/martadams89/seo-website-indexer/commit/c74136a48686f3f066250e536f6d61f1eccc1991))
* https for indexnow verificaiton ([1ffc70f](https://github.com/martadams89/seo-website-indexer/commit/1ffc70fe37eb6a25a3ce86c43d24b41eb0561b46))
* indexnow key roation ([93652f3](https://github.com/martadams89/seo-website-indexer/commit/93652f352e7ccfe1ee53bf2b651e54140c1372d9))
* label updtates ([9a2465e](https://github.com/martadams89/seo-website-indexer/commit/9a2465e4fc31fb718066da3e983711df02eb1e8b))
* ld-shcema updates ([a2dccfc](https://github.com/martadams89/seo-website-indexer/commit/a2dccfc641931b07c8331de7c4e0d099c9dcdd8e))
* **logs:** wrapping + tail-follow on mobile; perf, retention and CI hardening ([ed07ec3](https://github.com/martadams89/seo-website-indexer/commit/ed07ec385c9abd19cea29dc111c335871b7ceacd))
* put dumb-init outermost in entrypoint for correct signal handling ([33a04ce](https://github.com/martadams89/seo-website-indexer/commit/33a04ce757addb125fa4aed7393422edf50779a9))
* resolve "reply.sendFile is not a function" error on web interface ([5e06c25](https://github.com/martadams89/seo-website-indexer/commit/5e06c25efbb5e78d77a5af4e9f3ff436f78e1fbd))
* resolve container startup crash-loop (wrong frontend path + /data permissions) ([0b9e9b3](https://github.com/martadams89/seo-website-indexer/commit/0b9e9b398e9e4c99f5a1a6c2dbea3da1018cba64))
* scheduling ([8426220](https://github.com/martadams89/seo-website-indexer/commit/8426220ac121786d0c6cd6e26792b493332b27fe))
* update google search console url inspection endpoint path ([752a061](https://github.com/martadams89/seo-website-indexer/commit/752a0616cec3887defd16acbefe12cbef0093e96))
* update indexnow verification ([6543c86](https://github.com/martadams89/seo-website-indexer/commit/6543c86d01b728a434b3375aa53bde29240ca7d6))
* update naming ([b40d05b](https://github.com/martadams89/seo-website-indexer/commit/b40d05b58c9fa01097c3644cdab76edf48016a23))
* update Renovate schedule to run every 6 hours ([25f8b7a](https://github.com/martadams89/seo-website-indexer/commit/25f8b7a08502ee7459294e06a4fca49631384ecc))
* update Renovate schedule to run every 6 hours ([749a071](https://github.com/martadams89/seo-website-indexer/commit/749a071c04452af4001678d7c82ea8206263d1fb))


### 📚 Documentation

* add INDEXING_STATE_UNSPECIFIED description to GSC status tooltip ([b8f5ca0](https://github.com/martadams89/seo-website-indexer/commit/b8f5ca0eada806035167ec7d6145c66cb38ae8c5))
* improve Google OAuth setup documentation and add auth status polling to the Setup wizard ([a69addc](https://github.com/martadams89/seo-website-indexer/commit/a69addc1ffe92fc05cc39fd6220b02fb4de030c4))
* README covers the analytics/AI-citations wave, key economics and the new OAuth scope ([1a1fb8c](https://github.com/martadams89/seo-website-indexer/commit/1a1fb8cc78801edadb5512b53a3168f6f78b69aa))
* update authentication documentation to prioritize and clarify OAuth device flow setup ([29ceb2e](https://github.com/martadams89/seo-website-indexer/commit/29ceb2e070c97ba40c26e2bf27f9cb19b2fbff9b))
* update authentication documentation to reflect Google OAuth 2.0 Web Application flow migration ([02ed599](https://github.com/martadams89/seo-website-indexer/commit/02ed599ed94fa96310d9c28fd3adb52c7d53c85c))
* update license from MIT to GPLv3 in README ([4ed6709](https://github.com/martadams89/seo-website-indexer/commit/4ed6709059598ba6faa60d3a64a428d88b7a45a4))


### 🧹 Maintenance

* **deps:** update renovatebot/github-action action to v43.0.20 ([#20](https://github.com/martadams89/seo-website-indexer/issues/20)) ([f04601d](https://github.com/martadams89/seo-website-indexer/commit/f04601d491d55d3d584615f31b9c40ec1e75d28c))
* release 1.0.0 ([5fdc9cd](https://github.com/martadams89/seo-website-indexer/commit/5fdc9cd9cfc7800b9da9bd72929ea1c7cfdb890f))
* release 1.0.0 ([6ce6c67](https://github.com/martadams89/seo-website-indexer/commit/6ce6c679b301b8098d02b2476a706cc07a1d3f05))
* update frontend and backend node_modules dependencies and add CI/CD pipeline configuration ([0784694](https://github.com/martadams89/seo-website-indexer/commit/078469491402c61987729e2ab0a347d952773862))
