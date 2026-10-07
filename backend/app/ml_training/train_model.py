import os
import json
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import train_test_split

# Define segment patterns
DIGIT_SEGMENTS = {
    0: [1, 1, 1, 1, 1, 1, 0], # a,b,c,d,e,f
    1: [0, 1, 1, 0, 0, 0, 0], # b,c
    2: [1, 1, 0, 1, 1, 0, 1], # a,b,d,e,g
    3: [1, 1, 1, 1, 0, 0, 1], # a,b,c,d,g
    4: [0, 1, 1, 0, 0, 1, 1], # b,c,f,g
    5: [1, 0, 1, 1, 0, 1, 1], # a,c,d,f,g
    6: [1, 0, 1, 1, 1, 1, 1], # a,c,d,e,f,g
    7: [1, 1, 1, 0, 0, 0, 0], # a,b,c
    8: [1, 1, 1, 1, 1, 1, 1], # a,b,c,d,e,f,g
    9: [1, 1, 1, 1, 0, 1, 1]  # a,b,c,d,f,g
}

def draw_segment_digit(digit_class, slant=0.1, rotation=0, dx=0, dy=0, line_w=2, blur_r=0.5):
    # Create a 28x28 grayscale image with white background (255)
    img = Image.new('L', (28, 28), 255)
    draw = ImageDraw.Draw(img)
    
    # Bounding box coordinates for the digit
    # a top, b tr, c br, d bot, e bl, f tl, g mid
    # Let's define the points relative to a center box
    x0, x1 = 8 + dx, 20 + dx
    y0, y1, y2 = 4 + dy, 14 + dy, 24 + dy
    
    # Segment endpoints
    segments = {
        'a': [(x0, y0), (x1, y0)],
        'b': [(x1, y0), (x1, y1)],
        'c': [(x1, y1), (x1, y2)],
        'd': [(x0, y2), (x1, y2)],
        'e': [(x0, y1), (x0, y2)],
        'f': [(x0, y0), (x0, y1)],
        'g': [(x0, y1), (x1, y1)]
    }
    
    if digit_class in DIGIT_SEGMENTS:
        active = DIGIT_SEGMENTS[digit_class]
        seg_keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
        for i, key in enumerate(seg_keys):
            if active[i]:
                draw.line(segments[key], fill=0, width=line_w)
    elif digit_class == 10:
        # Class 10: Blank or noise (e.g. decimal point or random segments or empty)
        r = random.random()
        if r < 0.3:
            # Empty / blank
            pass
        elif r < 0.6:
            # Decimal point
            draw.ellipse([(18+dx, 22+dy), (21+dx, 25+dy)], fill=0)
        else:
            # Random noise segment
            num_lines = random.randint(1, 2)
            for _ in range(num_lines):
                lx0 = random.randint(4, 24)
                ly0 = random.randint(4, 24)
                lx1 = random.randint(4, 24)
                ly1 = random.randint(4, 24)
                draw.line([(lx0, ly0), (lx1, ly1)], fill=0, width=random.randint(1, 2))
                
    # Apply slant (shear transformation)
    # x_new = x + slant * y
    img = img.transform((28, 28), Image.Transform.AFFINE, (1, slant, 0, 0, 1, 0), fillcolor=255)
    
    # Apply rotation
    if rotation != 0:
        img = img.rotate(rotation, resample=Image.BILINEAR, fillcolor=255)
        
    # Apply blur
    if blur_r > 0:
        img = img.filter(ImageFilter.GaussianBlur(blur_r))
        
    # Convert to array and normalize to [0, 1] range
    arr = np.array(img, dtype=np.float32) / 255.0
    
    # Add random pixel noise
    noise = np.random.normal(0, 0.05, arr.shape)
    arr = np.clip(arr + noise, 0.0, 1.0)
    
    return arr.flatten()

def generate_dataset(samples_per_class=1000):
    X = []
    y = []
    
    for digit_class in range(11):
        for _ in range(samples_per_class):
            # Randomize parameters
            slant = random.uniform(-0.15, 0.25) # YIERYI digits are slanted slightly forward (positive slant)
            rotation = random.uniform(-6, 6)
            dx = random.randint(-2, 2)
            dy = random.randint(-2, 2)
            line_w = random.choice([2, 3])
            blur_r = random.uniform(0.3, 1.2)
            
            x_sample = draw_segment_digit(digit_class, slant, rotation, dx, dy, line_w, blur_r)
            X.append(x_sample)
            y.append(digit_class)
            
    return np.array(X), np.array(y)

def main():
    print("Generating synthetic 7-segment digit dataset...")
    X, y = generate_dataset(samples_per_class=1200)
    print(f"Dataset generated. Shape: X={X.shape}, y={y.shape}")
    
    # Split into train/test
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    print("Training MLP digit classifier...")
    # 3-layer MLP: 784 -> 128 -> 64 -> 11
    # We use relu activation and adam optimizer
    mlp = MLPClassifier(
        hidden_layer_sizes=(128, 64),
        activation='relu',
        solver='adam',
        max_iter=150,
        random_state=42,
        verbose=True
    )
    
    mlp.fit(X_train, y_train)
    
    train_acc = mlp.score(X_train, y_train)
    test_acc = mlp.score(X_test, y_test)
    print(f"Training completed. Train Accuracy: {train_acc:.4f}, Test Accuracy: {test_acc:.4f}")
    
    # Export weights and biases to JSON for raw NumPy and Javascript inference
    # scikit-learn stores weights in mlp.coefs_ and biases in mlp.intercepts_
    # coefs_[0] is W1 shape (784, 128)
    # coefs_[1] is W2 shape (128, 64)
    # coefs_[2] is W3 shape (64, 11)
    
    model_data = {
        "W1": mlp.coefs_[0].tolist(),
        "b1": mlp.intercepts_[0].tolist(),
        "W2": mlp.coefs_[1].tolist(),
        "b2": mlp.intercepts_[1].tolist(),
        "W3": mlp.coefs_[2].tolist(),
        "b3": mlp.intercepts_[2].tolist()
    }
    
    model_path = os.path.join(os.path.dirname(__file__), 'digit_model.json')
    with open(model_path, 'w') as f:
        json.dump(model_data, f)
        
    print(f"Model exported successfully to {model_path}")

if __name__ == "__main__":
    main()
