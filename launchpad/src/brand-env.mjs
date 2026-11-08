/** Read an operator setting: LAUNCHPAD_<NAME> from the environment, without changing the process environment. */
export function launchpadEnv(suffix, env = process.env) {
  if (typeof suffix !== 'string' || suffix.trim() !== suffix || !/^[A-Z][A-Z0-9_]*$/.test(suffix)) throw new TypeError('Invalid Launchpad environment setting name.');
  return env[`LAUNCHPAD_${suffix}`];
}
