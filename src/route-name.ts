import type { RouteLocation } from './model.js';

export const routeName = (route: Pick<RouteLocation, 'trailNames' | 'startName'>) =>
  route.trailNames.slice(0, 2).join(' / ') || route.startName || 'Unnamed trails';

export function gpxFilename(route: Pick<RouteLocation, 'trailNames' | 'startName' | 'distance'>, units: 'imperial' | 'metric'): string {
  const name = routeName(route).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 150).replace(/-+$/g, '') || 'unnamed-trails';
  const distance = (route.distance / (units === 'metric' ? 1000 : 1609.344)).toFixed(1).replace('.', '_');
  return `${name}-${distance}${units === 'metric' ? 'km' : 'mi'}.gpx`;
}
