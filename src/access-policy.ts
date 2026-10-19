import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionCatalog } from './data-format.js';
import type { AccessPointAssessment, AccessPointPolicy } from './model.js';

/** Prepared offline, shared by the map and every search worker. No spatial work at request time. */
async function policyFile(directory: string) {
  return readFile(join(directory, 'access-point-policy.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}
const digest = (text: string | undefined) => text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
export async function accessPolicyVersion(directory: string) { return digest(await policyFile(directory)); }

export async function readAccessPolicy(directory: string, catalog: SectionCatalog) {
  const text = await policyFile(directory);
  if (text === undefined) return undefined;
  const policy = JSON.parse(text) as AccessPointPolicy & { points: Record<string, AccessPointAssessment> };
  const invalid = () => { throw new Error('Prepared access-point policy is invalid or belongs to another catalog.'); };
  if (!policy || policy.catalogId !== catalog.info.id || !Number.isSafeInteger(policy.before) || policy.before < 0
    || !Number.isSafeInteger(policy.after) || policy.after < 0 || !Array.isArray(policy.rules)
    || !policy.rules.every(rule => typeof rule === 'string') || !policy.points || typeof policy.points !== 'object'
    || Array.isArray(policy.points)) invalid();
  const counts = new Map<string, number>();
  let kept = 0;
  for (const [id, point] of Object.entries(policy.points)) {
    const section = id.slice(0, id.indexOf('/'));
    if (!catalog.sections.some(entry => entry.id === section) || !id.slice(section.length + 1)
      || typeof point?.keep !== 'boolean' || typeof point.reason !== 'string') invalid();
    counts.set(section, (counts.get(section) ?? 0) + 1);
    kept += Number(point.keep);
  }
  if (policy.before !== Object.keys(policy.points).length || policy.after !== kept) invalid();
  for (const [id, count] of counts) if (catalog.sections.find(section => section.id === id)!.startCount !== count) invalid();
  const { catalogId, before, after, rules } = policy;
  return { version: digest(text)!, metadata: { catalogId, before, after, rules },
    assessment(section: string, start: string) {
      const point = policy.points[`${section}/${start}`];
      // A covered region must be complete; a missing record cannot silently restore a start.
      if (counts.has(section) && !point) invalid();
      return point;
    } };
}
