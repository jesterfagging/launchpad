/** Cache only exact immutable executable inspections, never launch enablement.
 * Every caller must still read and validate fresh finalized configuration and
 * loader headers. Concurrent cold readers share only the full ELF inspection.
 */
export function createDammPumpDeploymentProofCache({ inspect, loadBinary, verifyNetwork }) {
  const verified = new WeakMap(), running = new WeakMap(), observed = new WeakMap();
  return {
    minimumSlot(connection, initial = 0) { return Math.max(initial || 0, observed.get(connection) || 0); },
    observe(connection, slot) { observed.set(connection, Math.max(slot, observed.get(connection) || 0)); },
    async get({ connection, binary }) {
      const cached = verified.get(connection);
      if (cached) {
        await verifyNetwork(connection);
        return cached;
      }
      let pending = running.get(connection);
      if (!pending) {
        pending = Promise.resolve()
          .then(async () => inspect({ connection, binary: binary || await loadBinary() }))
          .then(inspection => {
            // Incomplete uploads are mutable and always need a new inspection.
            if (inspection.stage === 'deployed') verified.set(connection, inspection);
            return inspection;
          })
          .finally(() => { if (running.get(connection) === pending) running.delete(connection); });
        running.set(connection, pending);
      }
      return pending;
    },
  };
}
