/**
 * The Plan a Trip sample: the web app's start map and the tests' fixture. 17 nodes: six main branches
 * with 2, 0, 3, 2, 2 and 1 children; the first child of the fourth branch is long enough to wrap onto
 * two lines.
 */
import type { MapNode } from '../format/types.js';
import { mkNode } from './tree.js';

export const SAMPLE_MD = [
  '# Plan a Trip',
  '',
  '- Destination',
  '\t- Beach or mountains?',
  '\t- Which season is best to visit?',
  '- Set a budget for travel and stays',
  '- Bookings in the right order',
  '\t- Flights first, then hotels',
  '\t- Rental car for day trips and the airport transfer',
  '\t- Restaurant tables',
  '- Travel documents',
  '\t- Check passport validity and visa rules for every stop on the route',
  '\t- Get travel insurance',
  '- Local tips',
  '\t- Ask a friend who has been there',
  '\t- Download offline maps before you leave',
  '- Trip journal',
  '\t- Every evening write down the highlights',
  '',
].join('\n');

/** The same map as a fresh tree (unit tests). */
export function sampleMap(): MapNode {
  const n = (text: string, kids: readonly MapNode[] = []): MapNode => mkNode(text, kids);
  return n('Plan a Trip', [
    n('Destination', [n('Beach or mountains?'), n('Which season is best to visit?')]),
    n('Set a budget for travel and stays'),
    n('Bookings in the right order', [
      n('Flights first, then hotels'),
      n('Rental car for day trips and the airport transfer'),
      n('Restaurant tables'),
    ]),
    n('Travel documents', [
      n('Check passport validity and visa rules for every stop on the route'),
      n('Get travel insurance'),
    ]),
    n('Local tips', [n('Ask a friend who has been there'), n('Download offline maps before you leave')]),
    n('Trip journal', [n('Every evening write down the highlights')]),
  ]);
}
