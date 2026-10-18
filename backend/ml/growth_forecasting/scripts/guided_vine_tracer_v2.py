#!/usr/bin/env python3
"""Training-free full-vine tracing through ORDERED user waypoints.
Allows upward/downward growth and genuine hairpin turns; does not collapse parallel
runs. Each consecutive waypoint pair is solved independently using a color-guided
least-cost path. All geometry is 2D and requires visual review.
"""
import argparse, json
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.graph import route_through_array


def local_reference(lab, x, y, radius=3):
    h,w=lab.shape[:2]; patch=lab[max(0,y-radius):min(h,y+radius+1),max(0,x-radius):min(w,x+radius+1)]
    return np.median(patch.reshape(-1,3),axis=0)


def trace_pair(image, lab_full, p0, p1, corridor, scale):
    h,w=image.shape[:2]; pad=max(18,int(corridor*1.25))
    x0=max(0,min(p0[0],p1[0])-pad); x1=min(w,max(p0[0],p1[0])+pad+1)
    y0=max(0,min(p0[1],p1[1])-pad); y1=min(h,max(p0[1],p1[1])+pad+1)
    crop=image[y0:y1,x0:x1]
    sw=max(2,int(np.ceil(crop.shape[1]/scale))); sh=max(2,int(np.ceil(crop.shape[0]/scale)))
    small=cv2.resize(crop,(sw,sh),interpolation=cv2.INTER_AREA)
    lab=cv2.cvtColor(small,cv2.COLOR_BGR2LAB).astype(np.float32)
    refs=np.stack([local_reference(lab_full,*p).astype(np.float32) for p in (p0,p1)])
    # LAB similarity to the selected stem points; moderate penalty to avoid blindly following green leaves.
    d=np.min(np.linalg.norm((lab[None,:,:,:]-refs[:,None,None,:]) / np.array([1.8,1.,1.],np.float32),axis=-1),axis=0)
    color_cost=np.clip(d/32.,0,3)
    b,g,r=cv2.split(small.astype(np.float32)); green=np.clip((g-.65*r-.35*b)/65.,0,1)
    # Mild vegetation preference only: leaves are green too.
    green_cost=1-green
    yy,xx=np.mgrid[:sh,:sw]
    a=np.array([(p0[0]-x0)/scale,(p0[1]-y0)/scale]); z=np.array([(p1[0]-x0)/scale,(p1[1]-y0)/scale])
    v=z-a; t=np.clip(((xx-a[0])*v[0]+(yy-a[1])*v[1])/(np.dot(v,v)+1e-9),0,1)
    lateral=np.hypot(xx-(a[0]+t*v[0]),yy-(a[1]+t*v[1]))*scale
    # Soft corridor allows turns; penalizes large excursions to background structures.
    corridor_cost=np.maximum(0,(lateral-.38*corridor)/max(.62*corridor,1))**2
    cost=1+1.7*color_cost+.3*green_cost+4*corridor_cost
    cost=gaussian_filter(cost,.55)
    start=(int(np.clip(round(a[1]),0,sh-1)),int(np.clip(round(a[0]),0,sw-1)))
    end=(int(np.clip(round(z[1]),0,sh-1)),int(np.clip(round(z[0]),0,sw-1)))
    pixels,_=route_through_array(cost,start,end,fully_connected=True,geometric=True)
    pix=np.asarray(pixels,dtype=np.int32)
    path=np.column_stack([np.rint(x0+pix[:,1]*scale),np.rint(y0+pix[:,0]*scale)]).astype(np.int32)
    path=np.clip(path,[0,0],[w-1,h-1]);path[0]=p0;path[-1]=p1
    # Eliminate duplicate coordinates without reordering.
    keep=np.r_[True,np.any(np.diff(path,axis=0)!=0,axis=1)];path=path[keep]
    return path,float(color_cost[pix[:,0],pix[:,1]].mean()),float(np.max(lateral[pix[:,0],pix[:,1]]))


def run(image,points,out,corridor,scale,turn_angle, max_chord):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    h,w=image.shape[:2]; lab=cv2.cvtColor(image,cv2.COLOR_BGR2LAB).astype(np.float32)
    mask=np.zeros((h,w),np.uint8);overlay=image.copy();sections=[];flagged=[];total=0.
    for i,(a,b) in enumerate(zip(points[:-1],points[1:])):
        path,color_error,excursion=trace_pair(image,lab,a,b,corridor,scale)
        length=float(np.linalg.norm(np.diff(path.astype(float),axis=0),axis=1).sum())
        chord=float(np.linalg.norm(np.subtract(b,a)))
        ratio=length/max(chord,1.)
        reasons=[]
        if color_error>1.5:reasons.append('low_color_similarity')
        if chord>max_chord:reasons.append('large_waypoint_gap')
        if ratio>1.8:reasons.append('large_detour')
        if excursion>.85*corridor:reasons.append('corridor_boundary')
        # A sharp change at a waypoint is permitted (real vine reversals) but flagged for review.
        if 0<i<len(points)-2:
            prev=np.subtract(a,points[i-1]).astype(float); nxt=np.subtract(b,a).astype(float)
            if np.linalg.norm(prev)>0 and np.linalg.norm(nxt)>0:
                angle=np.degrees(np.arccos(np.clip(np.dot(prev,nxt)/(np.linalg.norm(prev)*np.linalg.norm(nxt)),-1,1)))
                if angle>turn_angle:reasons.append('sharp_turn_check_real_vine')
        # Always preserve the section, even if flagged: never delete genuine return paths.
        cv2.polylines(mask,[path],False,255,1,cv2.LINE_8)
        cv2.polylines(overlay,[path],False,(0,140,255) if reasons else (0,220,0),2,cv2.LINE_AA)
        total+=length
        sections.append(dict(section=i+1,start_xy=list(a),end_xy=list(b),length_px=round(length,2),chord_px=round(chord,2),length_chord_ratio=round(ratio,3),mean_color_penalty=round(color_error,3),max_corridor_excursion_px=round(excursion,1),review_reasons=reasons,needs_review=bool(reasons)))
        if reasons:flagged.append(i+1)
    for i,p in enumerate(points):
        cv2.circle(overlay,p,4,(255,0,255),-1)
        cv2.putText(overlay,str(i+1),(p[0]+5,p[1]-4),cv2.FONT_HERSHEY_SIMPLEX,.38,(255,255,255),1,cv2.LINE_AA)
    cv2.imwrite(str(out/'guided_route_overlay.png'),overlay)
    cv2.imwrite(str(out/'final_main_stem_centerline.png'),mask)
    cv2.imwrite(str(out/'full_vine_centerline.png'),mask)
    report={'status':'EXPERIMENTAL_REQUIRES_VISUAL_REVIEW','objective':'full ordered vine trajectory including genuine upward and downward growth','waypoints_xy':[list(p) for p in points], 'route_length_px':round(total,2),'flagged_sections':flagged,'sections':sections,'warning':'Pixel length is a 2D image-path estimate, not physical or true 3D vine length. Occluded paths and tree/leaf shortcuts remain uncertain. The binary centerline merges overlapping pixels for display; use route_length_px to retain traversal order.'}
    (out/'guided_route_report.json').write_text(json.dumps(report,indent=2))
    print('Saved:',out,'\n2D route length:',round(total,2),'px; sections needing review:',flagged)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image',required=True);p.add_argument('--out',required=True)
    p.add_argument('--corridor',type=int,default=35);p.add_argument('--downsample',type=int,default=1)
    p.add_argument('--points-json',help='JSON list [[x,y],...] for reproducible runs')
    p.add_argument('--turn-review-angle',type=float,default=135)
    p.add_argument('--max-chord',type=float,default=130)
    args=p.parse_args();img=cv2.imread(args.image)
    if img is None:raise SystemExit('Cannot read image '+args.image)
    points=[]
    if args.points_json:
        raw=json.loads(Path(args.points_json).read_text());raw=raw.get('waypoints_xy',raw) if isinstance(raw,dict) else raw
        points=[tuple(map(int,xy)) for xy in raw]
    else:
        name='Full vine tracer V2 | left click IN VINE ORDER | U undo | Enter trace | Esc cancel'
        cv2.namedWindow(name,cv2.WINDOW_NORMAL);cv2.resizeWindow(name,min(img.shape[1],1000),min(img.shape[0],900))
        def callback(event,x,y,flags,param):
            if event==cv2.EVENT_LBUTTONDOWN:points.append((x,y))
        cv2.setMouseCallback(name,callback)
        while True:
            view=img.copy()
            for i,xy in enumerate(points):
                cv2.circle(view,xy,4,(255,0,255),-1);cv2.putText(view,str(i+1),(xy[0]+5,xy[1]-5),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
            for a,b in zip(points[:-1],points[1:]):cv2.line(view,a,b,(0,210,255),1)
            cv2.imshow(name,view);key=cv2.waitKey(30)&255
            if key in (10,13):break
            if key in (ord('u'),8) and points:points.pop()
            if key==27:cv2.destroyAllWindows();return
        cv2.destroyAllWindows()
    if len(points)<2:raise SystemExit('At least two ordered waypoints are required')
    h,w=img.shape[:2]
    if any(x<0 or y<0 or x>=w or y>=h for x,y in points):raise SystemExit('Waypoint outside image')
    run(img,points,args.out,args.corridor,args.downsample,args.turn_review_angle,args.max_chord)

if __name__=='__main__':main()
