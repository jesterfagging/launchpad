"""Same fee-aware executable suite, ordinary public creator and $20k/$50k policy."""
import importlib.util, pathlib, json
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parent
source=ROOT.parent/'curve-damm-pump-admin-test/tests/admin_test_vm.py'
spec=importlib.util.spec_from_file_location('fee_suite',source)
suite=importlib.util.module_from_spec(spec);spec.loader.exec_module(suite)
suite.h.PROGRAM=suite.h.P('5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw')
suite.h.BINARY=ROOT/'artifacts/curve_damm_pump_fee.so'
suite.FIXTURE=HERE/'damm_fixture.mjs'
suite.OWNER_ONLY=False
suite.EXPECTED_START=20000
suite.EXPECTED_END=50000
if __name__=='__main__':
 report=suite.run()
 (ROOT/'public-fee-vm-results.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
