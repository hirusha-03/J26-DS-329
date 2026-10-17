#!/usr/bin/env python3
"""Research prototype: zero-click color-proposal prompting for SAM2, then candidate path extraction.
NOT a trained vanilla detector. Results require independent ground-truth validation.
Run from the SAM2 repository root; supports one vine per image, not identity detection.
"""
import argparse, csv, json, subprocess, sys
from pathlib import Path
import cv2
import numpy as np

def windows(h, size, overlap):
    if size >= h: return [(0,h)]
    step=size-overlap
    starts=list(range(0,h-size+1,step))
    if starts[-1]!=h-size: starts.append(h-size)
    return [(y,y+size) for y in starts]

def proposals(crop, max_points):
    hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
    # Green-plant pixels: deliberately broad; not a vanilla classifier.
    green=cv2.inRange(hsv,np.array([28,35,25],np.uint8),np.array([95,255,255],np.uint8))
    green=cv2.morphologyEx(green,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
    h,w=green.shape
    pts=[]
    # Spread points over height; prioritize local green regions.
    for cy in np.linspace(24,h-25,max(2,max_points*2)).astype(int):
        y0=max(0,cy-20);y1=min(h,cy+21)
        n,labels,stats,centroids=cv2.connectedComponentsWithStats(green[y0:y1],8)
        ranked=sorted(range(1,n),key=lambda i:stats[i,cv2.CC_STAT_AREA],reverse=True)
        for i in ranked[:2]:
            if stats[i,cv2.CC_STAT_AREA]<8:continue
            x=int(round(centroids[i,0]));y=int(round(centroids[i,1]+y0))
            if 0<=x<w and 0<=y<h and all(np.hypot(x-px,y-py)>35 for px,py in pts):pts.append((x,y))
            if len(pts)>=max_points:break
        if len(pts)>=max_points:break
    return pts,green

def score_mask(m,score):
    ys,xs=np.where(m)
    if len(xs)<12:return -1e9
    h,w=m.shape
    height=int(ys.max()-ys.min()+1);width=int(xs.max()-xs.min()+1)
    # Penalize huge leaves/background; encourage vertical stem-like objects.
    fill=len(xs)/max(1,height*width)
    return float(score)+1.5*height/h-1.0*len(xs)/(h*w)-0.6*fill

def process_image(image_path, out, args, predictor):
    image=cv2.imread(str(image_path))
    if image is None:raise ValueError(f'Cannot read {image_path}')
    h,w=image.shape[:2]; mask=np.zeros((h,w),np.uint8)
    proposal_view=image.copy(); details=[]
    for y0,y1 in windows(h,args.crop_height,args.overlap):
        crop=image[y0:y1];points,green=proposals(crop,args.points_per_crop)
        chosen=[]
        if predictor is not None:
            predictor.set_image(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB))
            for x,y in points:
                with __import__('torch').inference_mode():
                    masks,scores,_=predictor.predict(point_coords=np.array([[x,y]],np.float32),point_labels=np.array([1],np.int32),multimask_output=True)
                k=max(range(len(masks)),key=lambda i:score_mask(masks[i]>0,scores[i]))
                m=np.asarray(masks[k]>0)
                if score_mask(m,scores[k]) < args.min_score:continue
                # Keep only SAM's component containing the seed.
                n,l,stats,_=cv2.connectedComponentsWithStats(m.astype(np.uint8),8)
                idx=int(l[y,x])
                if idx==0 or stats[idx,cv2.CC_STAT_AREA]<args.min_component:continue
                chosen.append((m & (l==idx)))
            for m in chosen:mask[y0:y1][m]=255
        for x,y in points:cv2.circle(proposal_view,(x,y+y0),3,(0,0,255),-1)
        details.append({'crop_y':[y0,y1],'proposed_points':len(points),'accepted_masks':len(chosen)})
    out.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(out/'00_auto_prompts.png'),proposal_view)
    cv2.imwrite(str(out/'01_sam2_candidate_mask.png'),mask)
    overlay=image.copy();overlay[mask>0]=(0.5*image[mask>0]+0.5*np.array([0,255,0])).astype(np.uint8)
    cv2.imwrite(str(out/'02_sam2_candidate_overlay.png'),overlay)
    report={'image':str(image_path),'image_size':[w,h],'prompt_count':sum(d['proposed_points'] for d in details),'sam_masks_accepted':sum(d['accepted_masks'] for d in details),'foreground_pixels':int((mask>0).sum()),'crops':details,'status':'PROPOSAL_ONLY' if predictor is None else 'CANDIDATE_REVIEW_REQUIRED','warning':'Automatic green-color prompts are not vanilla-specific. No validated length is produced.'}
    if predictor is not None and np.any(mask) and args.extractor:
        cmd=[sys.executable,str(args.extractor),'--image',str(image_path),'--mask',str(out/'01_sam2_candidate_mask.png'),'--out',str(out/'stem')]
        subprocess.run(cmd,check=True)
        p=out/'stem'/'06_report.json'
        if p.exists():
            r=json.loads(p.read_text());report['candidate_centerline_pixels']=r.get('candidate_visible_centerline_pixels');report['reaches_upper_quarter']=r.get('candidate_reaches_upper_quarter');report['reaches_lower_quarter']=r.get('candidate_reaches_lower_quarter');report['artificial_bridges']=r.get('artificial_bridges_in_candidate')
    (out/'report.json').write_text(json.dumps(report,indent=2))
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--images',required=True,help='Single photo or folder of photos')
    p.add_argument('--out',required=True)
    p.add_argument('--checkpoint',default='checkpoints/sam2.1_hiera_tiny.pt')
    p.add_argument('--config',default='configs/sam2.1/sam2.1_hiera_t.yaml')
    p.add_argument('--extractor',default='extract_main_stem.py')
    p.add_argument('--crop-height',type=int,default=420)
    p.add_argument('--overlap',type=int,default=160)
    p.add_argument('--points-per-crop',type=int,default=6)
    p.add_argument('--min-score',type=float,default=0.65)
    p.add_argument('--min-component',type=int,default=20)
    p.add_argument('--proposal-only',action='store_true',help='Test prompts without importing SAM2')
    args=p.parse_args()
    if args.crop_height<=args.overlap or args.points_per_crop<1:p.error('crop-height must exceed overlap and points-per-crop >= 1')
    root=Path(args.images)
    images=[root] if root.is_file() else sorted(f for f in root.iterdir() if f.suffix.lower() in {'.jpg','.jpeg','.png','.tif','.tiff'})
    if not images:p.error('No images found')
    predictor=None
    if not args.proposal_only:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        device='cuda' if torch.cuda.is_available() else 'cpu'
        print('Loading SAM2 on',device)
        predictor=SAM2ImagePredictor(build_sam2(args.config,args.checkpoint,device=device))
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    rows=[]
    for f in images:
        try:
            r=process_image(f,out/f.stem,args,predictor);rows.append(r)
            print(f.name,r['status'],'pixels=',r['foreground_pixels'])
        except Exception as e:
            rows.append({'image':str(f),'status':'ERROR','error':str(e)})
            print(f.name,'ERROR:',e,file=sys.stderr)
    fields=['image','status','prompt_count','sam_masks_accepted','foreground_pixels','candidate_centerline_pixels','reaches_upper_quarter','reaches_lower_quarter','artificial_bridges','error']
    with (out/'batch_summary.csv').open('w',newline='') as fp:
        writer=csv.DictWriter(fp,fieldnames=fields,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
    print('Results:',out)

if __name__=='__main__':main()
