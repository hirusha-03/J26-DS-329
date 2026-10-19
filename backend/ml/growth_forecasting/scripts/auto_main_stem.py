#!/usr/bin/env python3
"""Experimental automatic main-stem extraction from a SAM2 mask.
Requires: opencv-python, numpy, scipy, scikit-image.
This is a 2D hypothesis, not a validated biological stem trace.
"""
import argparse, os, heapq
import cv2, numpy as np
from skimage.morphology import skeletonize, remove_small_objects
from scipy.ndimage import convolve

p=argparse.ArgumentParser()
p.add_argument('--mask',required=True);p.add_argument('--image',required=True);p.add_argument('--out',default='auto_clean')
p.add_argument('--min-area',type=int,default=35)
p.add_argument('--spur-length',type=float,default=45)
p.add_argument('--min-vertical-span',type=int,default=180)
a=p.parse_args();os.makedirs(a.out,exist_ok=True)
img=cv2.imread(a.image);raw=cv2.imread(a.mask,cv2.IMREAD_GRAYSCALE)
if img is None or raw is None: raise SystemExit('Cannot read image/mask: check absolute paths')
if img.shape[:2]!=raw.shape:raise SystemExit('Image and mask dimensions differ')
mask=raw>127
mask=remove_small_objects(mask,min_size=a.min_area,connectivity=2)
# Skeletonize without closing gaps or thickening mask.
skel=skeletonize(mask)
H,W=skel.shape
neighbors=[(dy,dx,1.41421356237 if dy and dx else 1.) for dy in (-1,0,1) for dx in (-1,0,1) if dy or dx]
def adj(pt, active):
 y,x=pt
 for dy,dx,w in neighbors:
  yy,xx=y+dy,x+dx
  if 0<=yy<H and 0<=xx<W and active[yy,xx]:yield (yy,xx),w

def degrees(active):return convolve(active.astype(np.uint8),np.ones((3,3),np.uint8),mode='constant')-active.astype(np.uint8)
# Remove short terminal spurs, but do not delete long paths or isolated stems.
for _ in range(12):
 deg=degrees(skel); endpoints=list(map(tuple,np.argwhere(skel & (deg==1))))
 to_remove=set()
 for start in endpoints:
  path=[start]; prev=None; cur=start; dist=0.
  while True:
   choices=[(n,w) for n,w in adj(cur,skel) if n!=prev]
   if len(choices)!=1:break
   nxt,w=choices[0];dist+=w
   if deg[nxt]>=3:
    if dist<a.spur_length:to_remove.update(path)
    break
   if deg[nxt]==1:break # separate short components handled by area filter
   path.append(nxt);prev,cur=cur,nxt
 if not to_remove:break
 for y,x in to_remove:skel[y,x]=False
# Find skeleton component with greatest vertical extent, prefer bottom-to-top span.
n,labels,stats,centroids=cv2.connectedComponentsWithStats(skel.astype(np.uint8),8)
candidates=[]
for k in range(1,n):
 x,y,w,h,area=stats[k]
 if h>=a.min_vertical_span:candidates.append((h,area,k))
if not candidates:
 print('WARNING: no long connected component. Check mask; cannot infer continuous stem.')
 chosen=None
else:chosen=max(candidates)[2]
route=np.zeros_like(skel)
if chosen is not None:
 component=labels==chosen
 deg=degrees(component)
 endpoints=list(map(tuple,np.argwhere(component & (deg==1))))
 if len(endpoints)<2:
  print('WARNING: selected component has fewer than 2 endpoints; no route produced.')
 else:
  # Select a bottom endpoint, then find shortest-path distances to all upper endpoints.
  bottom=max(endpoints,key=lambda t:t[0]);dist={bottom:0.};parent={};q=[(0.,bottom)]
  while q:
   d,u=heapq.heappop(q)
   if d!=dist[u]:continue
   for v,w in adj(u,component):
    nd=d+w
    if nd<dist.get(v,float('inf')):
     dist[v]=nd;parent[v]=u;heapq.heappush(q,(nd,v))
  upper=[e for e in endpoints if e in dist and e[0]<bottom[0]-a.min_vertical_span]
  if upper:
   top=min(upper,key=lambda t:t[0]);cur=top
   while cur!=bottom:route[cur]=True;cur=parent[cur]
   route[bottom]=True
   print('Candidate route pixels:',int(route.sum()),'geodesic pixel length:',round(dist[top],2))
  else:print('WARNING: no upper endpoint reachable from bottom endpoint')
# Save masks and visual comparison; route is not a measurement until verified.
cv2.imwrite(os.path.join(a.out,'01_area_filtered_mask.png'),mask.astype(np.uint8)*255)
cv2.imwrite(os.path.join(a.out,'02_pruned_skeleton.png'),skel.astype(np.uint8)*255)
cv2.imwrite(os.path.join(a.out,'03_candidate_main_path.png'),route.astype(np.uint8)*255)
overlay=img.copy();overlay[mask]=(.65*overlay[mask]+.35*np.array([255,0,255])).astype(np.uint8)
overlay[route]=[0,0,255]
cv2.imwrite(os.path.join(a.out,'04_candidate_overlay.png'),overlay)
print('Outputs:',os.path.abspath(a.out))
print('IMPORTANT: red line is only a candidate; review missed sections and false connections.')
