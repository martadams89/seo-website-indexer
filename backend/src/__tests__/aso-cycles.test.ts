import {it,expect} from 'vitest';
import {analyzeListing,validateListing} from '../platform/aso.js';
const draft=()=>validateListing({platform:'apple',locale:'en-GB',name:'Evidence App',subtitle:'Property inspections',description:'Capture property evidence.',keywords:'report',promotional_text:'',target_terms:[]});
it("Identify Apple keyword entries already represented in the name or subtitle.",()=>{const d=draft();d.keywords='evidence,report';expect(analyzeListing(d).findings.some(f=>f.title==='Keywords repeat name or subtitle')).toBe(true);});
it("Detect wasted empty Apple keyword entries caused by repeated or trailing commas.",()=>{const d=draft();d.keywords='report,,survey,';expect(analyzeListing(d).findings.some(f=>f.title==='Empty keyword entries')).toBe(true);});
it("Make target-term coverage word-aware so app does not match happy, while supporting CJK phrases.",()=>{const d=draft();d.name='Happy';d.target_terms=['app'];expect(analyzeListing(d).terms[0].fields).toEqual([]);d.name='証拠記録';d.target_terms=['証拠'];expect(analyzeListing(d).terms[0].fields).toContain('name');});
it("Normalise Unicode compatibility forms when checking target-term coverage.",()=>{const d=draft();d.name='Ｅｖｉｄｅｎｃｅ';d.target_terms=['evidence'];expect(analyzeListing(d).terms[0].fields).toContain('name');});
it("Deduplicate target terms across case and Unicode variants before saving drafts.",()=>{expect(validateListing({...draft(),target_terms:['Evidence','evidence','Ｅｖｉｄｅｎｃｅ']}).target_terms).toHaveLength(1);});
