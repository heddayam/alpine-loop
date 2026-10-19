"""Offline gateway classification using one rule across installed regions; never changes prepared graphs.
Run with existing Shapely/rasterio environment and osmium-extracted GeoJSON-sequence masks.
Arguments: prepared_root positive_mask developed_mask way_opl route_opl extra_route_opl [report_json]
"""
import collections,gzip,json,math,sys,time
from pathlib import Path
import shapely
from shapely.geometry import LineString,box,shape
from rasterio.warp import transform as warp
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/prepare'))
from osm import records
from graph import permission,VEHICLE_MODES
from access_policy import APPROACH_METERS,explicit_trail,hiking_distances
began=time.perf_counter();root,positiveFile,developedFile,waysFile,routeFile,extraFile=map(Path,sys.argv[1:7])
reportFile=Path(sys.argv[7]) if len(sys.argv)>7 else Path('benchmarks/access-point-policy-2026-10-13.json')
catalog=json.loads((root/'catalog.json').read_text());regions=[s for s in catalog['sections'] if (root/'sections'/s['id']/'starts.json.gz').is_file()]
roi=box(min(s['bounds'][0] for s in regions)-.01,min(s['bounds'][1] for s in regions)-.01,max(s['bounds'][2] for s in regions)+.01,max(s['bounds'][3] for s in regions)+.01)
metric=f"EPSG:{(32600 if roi.centroid.y>=0 else 32700)+max(1,min(60,int((roi.centroid.x+180)//6)+1))}"
def project(g):
 return shapely.transform(g,lambda x,y:warp('EPSG:4326',metric,x,y),interleaved=False)
def mask(file,positive):
 polys=[];types=collections.Counter()
 for line in file.open():
  if not line.strip('\x1e\n '):continue
  f=json.loads(line.lstrip('\x1e'));t=f['properties'];g=shape(f['geometry'])
  if not g.intersects(roi):continue
  if positive:
   qualify=t.get('natural') in {'wood','scrub','heath','grassland','fell','wetland','bare_rock','beach'} or t.get('landuse') in {'forest','meadow','recreation_ground'} or t.get('leisure') in {'park','nature_reserve'} or t.get('boundary')=='national_park' or (t.get('boundary')=='protected_area' and t.get('protect_class') in {'1','1a','1b','2','3','4','5','6'})
  else:qualify=t.get('landuse') in {'residential','commercial','industrial','retail'} or t.get('amenity') in {'school','college','university'}
  if not qualify:continue
  if not g.is_valid:g=shapely.make_valid(g)
  polys.append(g.intersection(roi));types[next((k+':'+str(t[k]) for k in ['natural','landuse','leisure','boundary','amenity'] if k in t),'other')]+=1
 projected=project(polys)
 print('Mask',positive,len(polys),flush=True)
 return projected,dict(types)
positive,positiveTypes=mask(positiveFile,True);developed,developedTypes=mask(developedFile,False)
posTree=shapely.STRtree(positive);devTree=shapely.STRtree(developed)
ways={i:t for i,_,t in records(waysFile)}
rels={i:(a,t) for f in [routeFile,extraFile] for i,a,t in records(f) if i.startswith('r')};missing=set()
def routeWays(identity,seen):
 if identity in seen:return set()
 if identity not in rels:missing.add(identity);return set()
 found=set()
 for member in rels[identity][0].get('M','').split(','):
  ref=member.split('@')[0]
  if ref.startswith('w'):found.add(ref)
  elif ref.startswith('r'):found|=routeWays(ref,seen|{identity})
 return found
hiking=set().union(*(routeWays(i,set()) for i,(a,t) in rels.items() if t.get('route')=='hiking'))
points={};summaries=[];checks=collections.defaultdict(list);official=[];details=[];contextMisses=[]
expected={'Dipsea Trail','Sun Trail','Newell Creek Trail','Sunnyside Trail','Swanson Creek Trail','Cataract Trail','Sunol Ridge Trail','Sproul Plaza','Campanile Way','Orangewood Drive','Snow Lake Trail','Mount Si Trail','Rattlesnake Ledge Trail','Skyline Trail','Paradise Glacier Trail','Maple Pass Loop','Colchuck Lake Trail','Enchantments Trail'}
for section in regions:
 sid=section['id'];folder=root/'sections'/sid
 data=json.loads(gzip.decompress((folder/'graph.json.gz').read_bytes()));g=data['graph']
 starts=json.loads(gzip.decompress((folder/'starts.json.gz').read_bytes()))
 lineage=json.loads(gzip.decompress((root/'audit'/sid/'source-index.json.gz').read_bytes()))
 geo=project([LineString(json.loads(line)) for line in gzip.open(folder/'geometry.jsonl.gz','rt')])
 core=[];scores=[];relation=[];explicitTrails=[]
 for i,line in enumerate(geo):
  corridor=line.buffer(30);hits=posTree.query(corridor,predicate='intersects')
  green=shapely.union_all(shapely.intersection(positive[hits],corridor)) if len(hits) else shapely.GeometryCollection()
  bad=devTree.query(corridor,predicate='intersects')
  if len(bad) and not green.is_empty:green=green.difference(shapely.union_all(shapely.intersection(developed[bad],corridor)))
  score=green.area/corridor.area if corridor.area else 0
  sourceways={ 'w'+str(p['way']) for seg in lineage['trails'][i]['segments'] for p in seg['source'] }
  proof=bool(sourceways) and sourceways<=hiking
  explicitTrails.append(data['trails'][i]['kind']=='trail' and bool(sourceways) and all(explicit_trail(ways.get(w,{})) for w in sourceways))
  closedTrack=bool(sourceways) and all(ways.get(w,{}).get('highway')=='track' and all(permission(ways[w],side,VEHICLE_MODES) is None for side in ['forward','backward']) for w in sourceways)
  eligible=(data['trails'][i]['kind']=='trail' or closedTrack) and (score>=.5 or proof)
  scores.append(score);relation.append(proof);core.append(eligible)
 dist=hiking_distances(g['edges'],core,allow_roads=True)
 trailDist=hiking_distances(g['edges'],core,allow_roads=False)
 directTrailNodes={node for edge in g['edges'] if explicitTrails[edge['trail']] for node in (edge['from'],edge['to'])}
 before=collections.Counter();after=collections.Counter()
 for start,position in starts:
  d=(trailDist if start['kind']=='road-contact' else dist).get(start['node'],math.inf);contextKeep=d<=APPROACH_METERS
  directTrail=start['node'] in directTrailNodes
  keep=start['kind']=='trailhead' or directTrail or contextKeep
  if start['kind']=='trailhead' and not contextKeep:contextMisses.append({'id':sid+'/'+start['id'],'name':start['name'],'position':position})
  reason=('Touches a network with mapped hiking or natural/recreation evidence.' if d==0 else ('Trail connection to a supported network within half a mile, without road walking.' if start['kind']=='road-contact' else 'Walking connection to a supported network within half a mile.')) if keep else ('No supported hiking network within half a mile along trails without road walking.' if start['kind']=='road-contact' else 'No supported hiking network within half a mile along mapped walking connections.')
  if start['kind']=='trailhead':reason='Explicitly mapped trailhead, direct hiking access evidence.'
  elif directTrail:reason='Direct walking access to a mapped path or bridleway.'
  identity=sid+'/'+start['id'];points[identity]={'keep':keep,'reason':reason}
  before[start['kind']]+=1;after[start['kind']]+=keep
  if start['id'] in {'osm-entrance:1588476939','osm-entrance:53054218','osm-entrance:52989588'}:details.append({'id':identity,'name':start['name'],'kind':start['kind'],'keep':keep,'position':position,'connectorMeters':round(d,1) if math.isfinite(d) else None})
 for i,t in enumerate(data['trails']):
  if t['name'] in expected:checks[t['name']].append({'meters':geo[i].length,'core':core[i],'originalTrail':t['kind']=='trail','score':scores[i]})
 # Independent USGS geometric check: high-overlap OSM trail portions in three focal areas.
 trailIndexes=[i for i,t in enumerate(data['trails']) if t['kind']=='trail'];trailTree=shapely.STRtree(geo[trailIndexes])
 for file in Path('/private/tmp').glob('alpine-usgs-*.json'):
  reference=json.loads(file.read_text());lines=[]
  for f in reference.get('features',[]):
   p=shape(f['geometry'])
   if p.intersects(shape(section['boundary'])):lines.append(p)
  if not lines:continue
  referenceGeometry=shapely.union_all(project(lines)).buffer(20)
  matches=trailTree.query(referenceGeometry,predicate='intersects');matched=[]
  for local in matches:
   i=trailIndexes[local];line=geo[i]
   if line.length>=20 and line.intersection(referenceGeometry).length/line.length>=.8:matched.append(i)
  official.append({'region':section['name'],'sample':file.stem,'referenceFeatures':len(lines),'matchedTrailCorridors':len(matched),'coreCorridors':sum(core[i] for i in matched),'matchedMeters':round(sum(geo[i].length for i in matched),1),'coreMeters':round(sum(geo[i].length for i in matched if core[i]),1),'notCoreExamples':[{'name':data['trails'][i]['name'],'meters':round(geo[i].length,1),'spatialScore':round(scores[i],3)} for i in matched if not core[i]][:8],'truncated':bool(reference.get('exceededTransferLimit',False))})
 summaries.append({'region':section['name'],'state':section['state'],'before':dict(before),'after':dict(after),'outdoorTrailMeters':round(sum(line.length for line,b in zip(geo,core) if b),1)})
 print(json.dumps(summaries[-1]),flush=True)
report={'catalogId':catalog['info']['id'],'sourceDate':catalog['info']['sourceDate'],'before':len(points),'after':sum(p['keep'] for p in points.values()),'rules':['A trail corridor qualifies when at least half of its 30 m surroundings overlaps mapped natural/recreation areas after subtracting developed land, or every source way belongs to a mapped hiking route.','Walking-permitted tracks closed to motor vehicles can also qualify using the same spatial or hiking-route evidence.','Road contacts must reach a qualifying corridor within 804.672 m (half a mile) along directed walking trails, without road connectors.','Parking must reach a qualifying corridor within 804.672 m (half a mile) along the existing directed walking graph.','Direct contact with a walking corridor whose source ways are all highway=path or highway=bridleway qualifies independently of context, excluding footway=sidewalk and footway=crossing.','Explicitly mapped trailheads carry direct hiking access evidence; walking and arrival prohibitions remain enforced.'],'regions':summaries,'namedChecks':[{'name':name,'preparedMeters':round(sum(p['meters'] for p in pieces),1),'originalTrailMeters':round(sum(p['meters'] for p in pieces if p['originalTrail']),1),'qualifiedNetworkMeters':round(sum(p['meters'] for p in pieces if p['core']),1)} for name,pieces in checks.items()],'spotChecks':details,'trailheadsWithoutNearbyContext':contextMisses,'usgsChecks':official,'positiveMaskTypes':positiveTypes,'developedMaskTypes':developedTypes,'unresolvedNestedHikingRelations':len(missing),'elapsedSeconds':round(time.perf_counter()-began,2),'scope':'One rule across all installed regions. Offline decisions can be activated as access-point-policy.json; graphs and region boundaries remain unchanged. Named checks cover prepared portions, not whole hikes. No solver run or route recall certification. USGS comparisons are geometric samples, not a complete independent trail inventory.','points':points}
(root/'access-point-trial.json').write_text(json.dumps(report,separators=(',',':'))+'\n')
reportFile.write_text(json.dumps({k:v for k,v in report.items() if k!='points'},indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in {'points','positiveMaskTypes','developedMaskTypes'}},indent=2))
