'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{decodeSMC,readTemperatures}=require('../mac/smc.cjs');
test('Mac CPU/GPU hotspots use separate actual sensor maxima, not a fabricated average',()=>{
    const t=decodeSMC({source:'AppleSMC',available:true,cpuSensors:[{key:'Te05',celsius:15},{key:'Tp01',celsius:44.25},{key:'Tp05',celsius:41.5}],gpuSensors:[{key:'Tg0G',celsius:37.2},{key:'Tg0H',celsius:39.1}]});
    assert.equal(t.cpu,44.25);assert.equal(t.gpu,39.1);assert.equal(t.aggregation,'max');assert.equal(t.cpuSensors.length,3);
});
test('invalid, missing and cross-group SMC readings never become a zero temperature',()=>{
    const t=decodeSMC({source:'AppleSMC',available:true,cpuSensors:[{key:'Te05',celsius:0},{key:'Te0S',celsius:0.1},{key:'Te09',celsius:9.99},{key:'Tp01',celsius:NaN},{key:'Tp05',celsius:Infinity},{key:'Tp09',celsius:151},{key:'Tp0D',celsius:-1},{key:'Tg0G',celsius:40},{key:'Tp0V',celsius:'43'}],gpuSensors:[]});
    assert.equal(t.cpu,null);assert.equal(t.gpu,null);assert.equal(t.cpuSensors.length,0);
});
test('failed or unknown SMC sources remain unavailable',()=>{
    assert.equal(decodeSMC({available:false,source:'AppleSMC',cpuSensors:[{key:'Tp01',celsius:45}]}).cpu,null);
    assert.equal(decodeSMC({available:true,source:'unknown',cpuSensors:[{key:'Tp01',celsius:45}]}).cpu,null);
    assert.equal(decodeSMC(null).cpu,null);
});
test('unverified Mac models do not reuse M4 key mappings',async()=>{
    const t=await readTemperatures('unverified model');assert.equal(t.cpu,null);assert.equal(t.gpu,null);assert.match(t.reason,/尚未验证/);
});

test('parked M4 GPU 0.1 degree samples are missing, not a frozen near-zero temperature',()=>{const t=decodeSMC({source:'AppleSMC',available:true,cpuSensors:[{key:'Tp0b',celsius:54.08049}],gpuSensors:[{key:'Tg0H',celsius:0.1},{key:'Tg0L',celsius:0.1},{key:'Tg0e',celsius:0.1},{key:'Tg0k',celsius:0.1}]});assert.equal(t.cpu,54.08049);assert.equal(t.gpu,null);assert.deepEqual(t.gpuSensors,[]);});
