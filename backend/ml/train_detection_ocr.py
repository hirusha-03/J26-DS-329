import os
import numpy as np
import json
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# ---------------------------------------------------------
# 1. CNN Digit Recognition Architecture
# ---------------------------------------------------------
class DigitCNN(nn.Module):
    def __init__(self, num_classes=12):
        super(DigitCNN, self).__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2, 2), # 14x14
            
            nn.Conv2d(16, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2, 2), # 7x7
            
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU()
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 7 * 7, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, num_classes)
        )

    def forward(self, x):
        return self.classifier(self.features(x))

# ---------------------------------------------------------
# 2. Mock Training Loop (For Compilation & Pipeline Setup)
# ---------------------------------------------------------
def train_and_export_digit_cnn():
    print("Initializing Digit CNN training pipeline...")
    model = DigitCNN(num_classes=12)
    
    # Generate mock training dataset: 200 samples of 28x28 grayscale images
    X_train = np.random.randn(200, 1, 28, 28).astype(np.float32)
    y_train = np.random.randint(0, 12, size=(200,)).astype(np.int64)
    
    dataset = TensorDataset(torch.tensor(X_train), torch.tensor(y_train))
    loader = DataLoader(dataset, batch_size=32, shuffle=True)
    
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    
    model.train()
    for epoch in range(1, 4):
        total_loss = 0.0
        for batch_x, batch_y in loader:
            optimizer.zero_grad()
            outputs = model(batch_x)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        print(f"Epoch {epoch}/3 - Loss: {total_loss/len(loader):.4f}")
        
    print("Training finished. Exporting model to ONNX...")
    dummy_input = torch.randn(1, 1, 28, 28)
    onnx_path = "digit_cnn.onnx"
    torch.onnx.export(
        model, 
        dummy_input, 
        onnx_path, 
        input_names=['input'], 
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch_size'}, 'output': {0: 'batch_size'}}
    )
    print(f"ONNX model saved to {onnx_path}")
    
    # Instructions/Code for TFLite conversion
    print("\n--- To convert ONNX to TensorFlow Lite ---")
    print("Run the following python code on a machine with TensorFlow installed:")
    print("""
    import tensorflow as tf
    # Convert ONNX to TensorFlow saved_model first using onnx-tf
    # pip install onnx-tf tensorflow
    # then:
    # onnx-tf convert -i digit_cnn.onnx -o digit_cnn_saved_model
    
    # Convert to TFLite
    converter = tf.lite.TFLiteConverter.from_saved_model('digit_cnn_saved_model')
    converter.optimizations = [tf.lite.Optimize.DEFAULT] # integer quantization
    tflite_model = converter.convert()
    with open('digit_cnn.tflite', 'wb') as f:
        f.write(tflite_model)
    """)

# ---------------------------------------------------------
# 3. YOLOv8/v11 Training Commands
# ---------------------------------------------------------
def print_yolo_training_commands():
    print("\n--- YOLOv8/v11 Nano Training Guide ---")
    print("1. Install Ultralytics:")
    print("   pip install ultralytics")
    print("\n2. Prepare your data.yaml file:")
    print("""   path: ../dataset
   train: images/train
   val: images/val
   names:
     0: lcd_screen
     1: digit_box
    """)
    print("3. Train using the YOLO CLI:")
    print("   yolo detect train model=yolov8n.pt data=data.yaml epochs=100 imgsz=640")
    print("\n4. Export to TFLite format:")
    print("   yolo export model=runs/detect/train/weights/best.pt format=tflite")
    print("   (This generates best_saved_model/best_float16.tflite)")

if __name__ == "__main__":
    train_and_export_digit_cnn()
    print_yolo_training_commands()
