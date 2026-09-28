# Kronos Web UI

Web user interface for Kronos financial prediction model, providing intuitive graphical operation interface.

## ✨ Features

- **Forecast workspace layout**: Setup rail (model, data, window, sampling) beside a price chart, accuracy metrics, error chart, comparison table and session log
- **Multi-format data support**: CSV and Feather files from `data/` and the bundled sample in `finetune_csv/data/`
- **Configurable window**: Editable lookback and horizon, positioned on a draggable overview of the whole series (or with the slider and Earliest/Latest)
- **Real model prediction**: Kronos-mini, -small and -base, with the model's context limit shown when the lookback exceeds it
- **Prediction quality control**: Temperature, nucleus sampling (top-p) and number of averaged sample paths
- **Device detection**: CPU, CUDA and MPS, with devices not present on the server disabled
- **Comparison analysis**: Forecast drawn over the bars that actually followed, with MAE, RMSE, MAPE, bias, direction hit rate and horizon return, plus per-step errors and CSV export
- **Works offline**: plotly.js is served from the installed `plotly` Python package, no CDN required

## 🚀 Quick Start

### Method 1: Start with Python script
```bash
cd webui
python run.py
```

### Method 2: Start with Shell script
```bash
cd webui
chmod +x start.sh
./start.sh
```

### Method 3: Start Flask application directly
```bash
cd webui
python app.py
```

After successful startup, visit http://localhost:7070

## 📋 Usage Steps

1. **Load model**: Choose a checkpoint and device, then Load model
2. **Load data**: Choose a file and Load data (Rescan picks up newly added files)
3. **Set the window**: Enter lookback and horizon in bars, then drag on the overview or use the slider to position it
4. **Adjust sampling**: Temperature, top-p and sample paths (Defaults restores 1.00 / 0.90 / 1)
5. **Run forecast**: Click Run forecast or press Ctrl+Enter (Cmd+Enter on macOS)
6. **Review results**: Toggle the forecast between a range band and candles, switch linear/log scale, inspect errors and export the table

## 🔧 Prediction Quality Parameters

### Temperature (T)
- **Range**: 0.1 - 2.0
- **Effect**: Controls prediction randomness
- **Recommendation**: 1.2-1.5 for better prediction quality

### Nucleus Sampling (top_p)
- **Range**: 0.1 - 1.0
- **Effect**: Controls prediction diversity
- **Recommendation**: 0.95-1.0 to consider more possibilities

### Sample Count
- **Range**: 1 - 5
- **Effect**: Generate multiple prediction samples
- **Recommendation**: 2-3 samples to improve quality

## 📊 Supported Data Formats

### Required Columns
- `open`: Opening price
- `high`: Highest price
- `low`: Lowest price
- `close`: Closing price

### Optional Columns
- `volume`: Trading volume
- `amount`: Trading amount (not used for prediction)
- `timestamps`/`timestamp`/`date`: Timestamp

## 🤖 Model Support

- **Kronos-mini**: 4.1M parameters, lightweight fast prediction
- **Kronos-small**: 24.7M parameters, balanced performance and speed
- **Kronos-base**: 102.3M parameters, high quality prediction

## 🖥️ GPU Acceleration Support

- **CPU**: General computing, best compatibility
- **CUDA**: NVIDIA GPU acceleration, best performance
- **MPS**: Apple Silicon GPU acceleration, recommended for Mac users

## ⚠️ Notes

- `amount` column is not used for prediction, only for display
- The window needs lookback + horizon rows; the UI reports when the file is too short
- Kronos-small and -base read at most 512 bars of context, Kronos-mini 2048; a longer lookback is truncated to the most recent bars
- First model loading downloads weights from Hugging Face; the server needs access to huggingface.co

## 🔍 Comparison Analysis

Every forecast covers bars that exist in the file, so it is compared with what actually happened:
- Close MAE, RMSE, MAPE and mean bias
- Direction hit rate: share of steps where forecast and actual close sit on the same side of the last observed close
- Horizon return: forecast and actual change from the last observed close to the final step
- Per-step close error chart and a forecast/actual OHLC table, exportable as CSV

## 🛠️ Technical Architecture

- **Backend**: Flask + Python
- **Frontend**: HTML template with `static/css/workspace.css` and `static/js/workspace.js` (no build step)
- **Charts**: Plotly.js, served locally from the `plotly` package at `/vendor/plotly.min.js`
- **Data processing**: Pandas + NumPy
- **Model**: Hugging Face Transformers

## 📝 Troubleshooting

### Common Issues
1. **Port occupied**: Modify port number in app.py
2. **Missing dependencies**: Run `pip install -r requirements.txt`
3. **Model loading failed**: Check network connection and model ID
4. **Data format error**: Ensure data column names and format are correct

### Log Viewing
Detailed runtime information will be displayed in the console at startup, including model status and error messages.

## 📄 License

This project follows the license terms of the original Kronos project.

## 🤝 Contributing

Welcome to submit Issues and Pull Requests to improve this Web UI!

## 📞 Support

If you have questions, please check:
1. Project documentation
2. GitHub Issues
3. Console error messages
