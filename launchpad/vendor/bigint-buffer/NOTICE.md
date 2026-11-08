# Pure JavaScript integer conversion

Derived from the JavaScript conversion path in bigint-buffer 1.1.5 by Tim Fan (https://github.com/no2chem/bigint-buffer), licensed under Apache-2.0. The original license is included.

Modifications: removed all native bindings, C/C++ source, install scripts and unsafe buffer allocation. Added explicit unsigned-width and Buffer input validation. This small local package implements the four existing conversion exports used by @solana/buffer-layout-utils. It is not a patched upstream release and contains no signing or cryptographic implementation.

The npm override replaces bigint-buffer throughout the installed dependency graph. Removing it reintroduces the original native addon and CVE-2025-3194. All four Solana unsigned integer widths (64/128/192/256-bit), byte order, round trips and invalid values have regression coverage.

The application installs the adjacent vendor/launchpad-bigint-buffer-js-1.0.0.tgz archive using a lockfile integrity hash. When changing these sources, run npm pack ./vendor/bigint-buffer --pack-destination ./vendor --ignore-scripts from the application root, refresh the lockfile and rerun the integer-conversion tests.
