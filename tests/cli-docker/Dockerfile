# Flockctl CLI test image.
#
# Base: node:20-alpine matches the engines.node >=20 constraint from
# package.json.
#
# Measured size: ~361 MB. Target was <300 MB but the prod-deps layer alone
# is ~192 MB (AI SDKs: @anthropic-ai/*, openai, @google/generative-ai,
# @github/copilot-sdk pulled in via the main dep list). Further shrinking
# would require pruning unused provider SDKs from package.json, which is
# out of scope for a test-only image.
#
# NOTE on native modules: better-sqlite3 (currently installed version) does
# NOT ship a musl prebuild, so we MUST let npm run lifecycle scripts to
# compile it from source against the container's Node ABI. Doing this also
# means we need python3 + make + g++ in the builder environment; those are
# removed after the rebuild to keep the final image lean.
FROM node:20-alpine

# git is required by `flockctl project add` when the path is a git URL.
# The build toolchain (python3/make/g++) is needed only to compile
# better-sqlite3 and is purged after npm install below.
RUN apk add --no-cache git python3 make g++

WORKDIR /app

# Copy only what the runtime CLI needs. The host `build.ts` runs `npm run
# build` first so dist/ is up-to-date before the docker build context is
# packed. Source tree, tests, ui/, node_modules/ are excluded by
# .dockerignore.
COPY package.json package-lock.json ./
COPY dist ./dist
COPY migrations ./migrations
COPY src/bundled-skills ./src/bundled-skills
COPY src/resources ./src/resources

# Strip source maps. If left in place, c8 would remap coverage from dist/*.js
# to src/*.ts — but this image doesn't ship src/, so c8 silently drops every
# entry and coverage-final.json comes out as {}. Removing the .map files and
# the sourceMappingURL comments keeps c8 working against dist/ directly, which
# is what we want for CLI coverage.
RUN find dist -name "*.js.map" -delete \
 && find dist -name "*.js" -exec sed -i "/^\/\/# sourceMappingURL=/d" {} +

# Production deps only. Lifecycle scripts run so that better-sqlite3's
# native binding is built against the container's Node version. After the
# install we purge the build toolchain (but keep git) to shrink the image.
RUN npm install --omit=dev \
 && apk del python3 make g++ \
 && rm -rf /root/.npm /root/.node-gyp /tmp/*

# Put `flockctl` on PATH via the bin entry in package.json.
RUN npm link

# c8 drives coverage collection when the test runner execs into the container.
RUN npm install -g c8

# The runner attaches via `docker exec`; keep the container alive.
CMD ["sleep", "infinity"]
