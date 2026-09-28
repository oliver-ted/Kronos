import os
import pandas as pd
import numpy as np
import json
import plotly.graph_objects as go
import plotly.utils
from flask import Flask, Response, render_template, request, jsonify
from flask_cors import CORS
import sys
import warnings
import datetime
warnings.filterwarnings('ignore')

# Add project root directory to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(PROJECT_ROOT)

# Directories scanned for data files: the user data directory and the bundled fine-tuning sample
DATA_DIRS = [
    os.path.join(PROJECT_ROOT, 'data'),
    os.path.join(PROJECT_ROOT, 'finetune_csv', 'data'),
]

try:
    from model import Kronos, KronosTokenizer, KronosPredictor
    MODEL_AVAILABLE = True
except ImportError:
    MODEL_AVAILABLE = False
    print("Warning: Kronos model cannot be imported, will use simulated data for demonstration")

app = Flask(__name__)
CORS(app)

# Global variables to store models
tokenizer = None
model = None
predictor = None
current_model_key = None
current_device = None

# Available model configurations
AVAILABLE_MODELS = {
    'kronos-mini': {
        'name': 'Kronos-mini',
        'model_id': 'NeoQuasar/Kronos-mini',
        'tokenizer_id': 'NeoQuasar/Kronos-Tokenizer-2k',
        'context_length': 2048,
        'params': '4.1M',
        'description': 'Lightweight model, suitable for fast prediction'
    },
    'kronos-small': {
        'name': 'Kronos-small',
        'model_id': 'NeoQuasar/Kronos-small',
        'tokenizer_id': 'NeoQuasar/Kronos-Tokenizer-base',
        'context_length': 512,
        'params': '24.7M',
        'description': 'Small model, balanced performance and speed'
    },
    'kronos-base': {
        'name': 'Kronos-base',
        'model_id': 'NeoQuasar/Kronos-base',
        'tokenizer_id': 'NeoQuasar/Kronos-Tokenizer-base',
        'context_length': 512,
        'params': '102.3M',
        'description': 'Base model, provides better prediction quality'
    }
}

def load_data_files():
    """Scan data directories and return available data files"""
    data_files = []

    for data_dir in DATA_DIRS:
        if not os.path.isdir(data_dir):
            continue
        for file in sorted(os.listdir(data_dir)):
            if file.endswith(('.csv', '.feather')):
                file_path = os.path.join(data_dir, file)
                file_size = os.path.getsize(file_path)
                data_files.append({
                    'name': file,
                    'path': file_path,
                    'source': os.path.relpath(data_dir, PROJECT_ROOT),
                    'size': f"{file_size / 1024:.1f} KB" if file_size < 1024*1024 else f"{file_size / (1024*1024):.1f} MB"
                })

    return data_files

def detect_devices():
    """Report which compute devices torch can use on this machine"""
    devices = [{'id': 'cpu', 'label': 'CPU', 'available': True}]
    try:
        import torch
        devices.append({'id': 'cuda', 'label': 'CUDA (NVIDIA GPU)', 'available': bool(torch.cuda.is_available())})
        mps_backend = getattr(torch.backends, 'mps', None)
        devices.append({'id': 'mps', 'label': 'MPS (Apple Silicon)', 'available': bool(mps_backend and mps_backend.is_available())})
    except ImportError:
        pass
    return devices

def detect_timeframe(df):
    """Describe the sampling interval of the data from its first few timestamps"""
    if len(df) < 2:
        return "Unknown"

    time_diffs = []
    for i in range(1, min(10, len(df))):  # Check first 10 time differences
        diff = df['timestamps'].iloc[i] - df['timestamps'].iloc[i-1]
        time_diffs.append(diff)

    if not time_diffs:
        return "Unknown"

    # Calculate average time difference
    avg_diff = sum(time_diffs, pd.Timedelta(0)) / len(time_diffs)

    # Convert to readable format
    if avg_diff < pd.Timedelta(minutes=1):
        return f"{avg_diff.total_seconds():.0f} seconds"
    elif avg_diff < pd.Timedelta(hours=1):
        return f"{avg_diff.total_seconds() / 60:.0f} minutes"
    elif avg_diff < pd.Timedelta(days=1):
        return f"{avg_diff.total_seconds() / 3600:.0f} hours"
    else:
        return f"{avg_diff.days} days"

def bars_to_records(frame):
    """Convert OHLCV rows to JSON-serializable records"""
    records = []
    for _, row in frame.iterrows():
        records.append({
            'timestamp': row['timestamps'].isoformat(),
            'open': float(row['open']),
            'high': float(row['high']),
            'low': float(row['low']),
            'close': float(row['close']),
            'volume': float(row['volume']) if 'volume' in row else 0,
            'amount': float(row['amount']) if 'amount' in row else 0
        })
    return records

def load_data_file(file_path):
    """Load data file"""
    try:
        if file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
        elif file_path.endswith('.feather'):
            df = pd.read_feather(file_path)
        else:
            return None, "Unsupported file format"
        
        # Check required columns
        required_cols = ['open', 'high', 'low', 'close']
        if not all(col in df.columns for col in required_cols):
            return None, f"Missing required columns: {required_cols}"
        
        # Process timestamp column
        if 'timestamps' in df.columns:
            df['timestamps'] = pd.to_datetime(df['timestamps'])
        elif 'timestamp' in df.columns:
            df['timestamps'] = pd.to_datetime(df['timestamp'])
        elif 'date' in df.columns:
            # If column name is 'date', rename it to 'timestamps'
            df['timestamps'] = pd.to_datetime(df['date'])
        else:
            # If no timestamp column exists, create one
            df['timestamps'] = pd.date_range(start='2024-01-01', periods=len(df), freq='1H')
        
        # Ensure numeric columns are numeric type
        for col in ['open', 'high', 'low', 'close']:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        
        # Process volume column (optional)
        if 'volume' in df.columns:
            df['volume'] = pd.to_numeric(df['volume'], errors='coerce')
        
        # Process amount column (optional, but not used for prediction)
        if 'amount' in df.columns:
            df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
        
        # Remove rows containing NaN values; keep a positional index so row numbers match iloc
        df = df.dropna().reset_index(drop=True)
        
        return df, None
        
    except Exception as e:
        return None, f"Failed to load file: {str(e)}"

def save_prediction_results(file_path, prediction_type, prediction_results, actual_data, input_data, prediction_params):
    """Save prediction results to file"""
    try:
        # Create prediction results directory
        results_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prediction_results')
        os.makedirs(results_dir, exist_ok=True)
        
        # Generate filename
        timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'prediction_{timestamp}.json'
        filepath = os.path.join(results_dir, filename)
        
        # Prepare data for saving
        save_data = {
            'timestamp': datetime.datetime.now().isoformat(),
            'file_path': file_path,
            'prediction_type': prediction_type,
            'prediction_params': prediction_params,
            'input_data_summary': {
                'rows': len(input_data),
                'columns': list(input_data.columns),
                'price_range': {
                    'open': {'min': float(input_data['open'].min()), 'max': float(input_data['open'].max())},
                    'high': {'min': float(input_data['high'].min()), 'max': float(input_data['high'].max())},
                    'low': {'min': float(input_data['low'].min()), 'max': float(input_data['low'].max())},
                    'close': {'min': float(input_data['close'].min()), 'max': float(input_data['close'].max())}
                },
                'last_values': {
                    'open': float(input_data['open'].iloc[-1]),
                    'high': float(input_data['high'].iloc[-1]),
                    'low': float(input_data['low'].iloc[-1]),
                    'close': float(input_data['close'].iloc[-1])
                }
            },
            'prediction_results': prediction_results,
            'actual_data': actual_data,
            'analysis': {}
        }
        
        # If actual data exists, perform comparison analysis
        if actual_data and len(actual_data) > 0:
            # Calculate continuity analysis
            if len(prediction_results) > 0 and len(actual_data) > 0:
                last_pred = prediction_results[0]  # First prediction point
            first_actual = actual_data[0]      # First actual point
                
            save_data['analysis']['continuity'] = {
                    'last_prediction': {
                        'open': last_pred['open'],
                        'high': last_pred['high'],
                        'low': last_pred['low'],
                        'close': last_pred['close']
                    },
                    'first_actual': {
                        'open': first_actual['open'],
                        'high': first_actual['high'],
                        'low': first_actual['low'],
                        'close': first_actual['close']
                    },
                    'gaps': {
                        'open_gap': abs(last_pred['open'] - first_actual['open']),
                        'high_gap': abs(last_pred['high'] - first_actual['high']),
                        'low_gap': abs(last_pred['low'] - first_actual['low']),
                        'close_gap': abs(last_pred['close'] - first_actual['close'])
                    },
                    'gap_percentages': {
                        'open_gap_pct': (abs(last_pred['open'] - first_actual['open']) / first_actual['open']) * 100,
                        'high_gap_pct': (abs(last_pred['high'] - first_actual['high']) / first_actual['high']) * 100,
                        'low_gap_pct': (abs(last_pred['low'] - first_actual['low']) / first_actual['low']) * 100,
                        'close_gap_pct': (abs(last_pred['close'] - first_actual['close']) / first_actual['close']) * 100
                    }
                }
        
        # Save to file
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(save_data, f, indent=2, ensure_ascii=False)
        
        print(f"Prediction results saved to: {filepath}")
        return filepath
        
    except Exception as e:
        print(f"Failed to save prediction results: {e}")
        return None

def create_prediction_chart(df, pred_df, lookback, pred_len, actual_df=None, historical_start_idx=0):
    """Create prediction chart"""
    # Use specified historical data start position, not always from the beginning of df
    if historical_start_idx + lookback + pred_len <= len(df):
        # Display lookback historical points + pred_len prediction points starting from specified position
        historical_df = df.iloc[historical_start_idx:historical_start_idx+lookback]
        prediction_range = range(historical_start_idx+lookback, historical_start_idx+lookback+pred_len)
    else:
        # If data is insufficient, adjust to maximum available range
        available_lookback = min(lookback, len(df) - historical_start_idx)
        available_pred_len = min(pred_len, max(0, len(df) - historical_start_idx - available_lookback))
        historical_df = df.iloc[historical_start_idx:historical_start_idx+available_lookback]
        prediction_range = range(historical_start_idx+available_lookback, historical_start_idx+available_lookback+available_pred_len)
    
    # Create chart
    fig = go.Figure()
    
    # Add historical data (candlestick chart)
    fig.add_trace(go.Candlestick(
        x=historical_df['timestamps'] if 'timestamps' in historical_df.columns else historical_df.index,
        open=historical_df['open'],
        high=historical_df['high'],
        low=historical_df['low'],
        close=historical_df['close'],
        name='Historical Data (400 data points)',
        increasing_line_color='#26A69A',
        decreasing_line_color='#EF5350'
    ))
    
    # Add prediction data (candlestick chart)
    if pred_df is not None and len(pred_df) > 0:
        # Calculate prediction data timestamps - ensure continuity with historical data
        if 'timestamps' in df.columns and len(historical_df) > 0:
            # Start from the last timestamp of historical data, create prediction timestamps with the same time interval
            last_timestamp = historical_df['timestamps'].iloc[-1]
            time_diff = df['timestamps'].iloc[1] - df['timestamps'].iloc[0] if len(df) > 1 else pd.Timedelta(hours=1)
            
            pred_timestamps = pd.date_range(
                start=last_timestamp + time_diff,
                periods=len(pred_df),
                freq=time_diff
            )
        else:
            # If no timestamps, use index
            pred_timestamps = range(len(historical_df), len(historical_df) + len(pred_df))
        
        fig.add_trace(go.Candlestick(
            x=pred_timestamps,
            open=pred_df['open'],
            high=pred_df['high'],
            low=pred_df['low'],
            close=pred_df['close'],
            name='Prediction Data (120 data points)',
            increasing_line_color='#66BB6A',
            decreasing_line_color='#FF7043'
        ))
    
    # Add actual data for comparison (if exists)
    if actual_df is not None and len(actual_df) > 0:
        # Actual data should be in the same time period as prediction data
        if 'timestamps' in df.columns:
            # Actual data should use the same timestamps as prediction data to ensure time alignment
            if 'pred_timestamps' in locals():
                actual_timestamps = pred_timestamps
            else:
                # If no prediction timestamps, calculate from the last timestamp of historical data
                if len(historical_df) > 0:
                    last_timestamp = historical_df['timestamps'].iloc[-1]
                    time_diff = df['timestamps'].iloc[1] - df['timestamps'].iloc[0] if len(df) > 1 else pd.Timedelta(hours=1)
                    actual_timestamps = pd.date_range(
                        start=last_timestamp + time_diff,
                        periods=len(actual_df),
                        freq=time_diff
                    )
                else:
                    actual_timestamps = range(len(historical_df), len(historical_df) + len(actual_df))
        else:
            actual_timestamps = range(len(historical_df), len(historical_df) + len(actual_df))
        
        fig.add_trace(go.Candlestick(
            x=actual_timestamps,
            open=actual_df['open'],
            high=actual_df['high'],
            low=actual_df['low'],
            close=actual_df['close'],
            name='Actual Data (120 data points)',
            increasing_line_color='#FF9800',
            decreasing_line_color='#F44336'
        ))
    
    # Update layout
    fig.update_layout(
        title='Kronos Financial Prediction Results - 400 Historical Points + 120 Prediction Points vs 120 Actual Points',
        xaxis_title='Time',
        yaxis_title='Price',
        template='plotly_white',
        height=600,
        showlegend=True
    )
    
    # Ensure x-axis time continuity
    if 'timestamps' in historical_df.columns:
        # Get all timestamps and sort them
        all_timestamps = []
        if len(historical_df) > 0:
            all_timestamps.extend(historical_df['timestamps'])
        if 'pred_timestamps' in locals():
            all_timestamps.extend(pred_timestamps)
        if 'actual_timestamps' in locals():
            all_timestamps.extend(actual_timestamps)
        
        if all_timestamps:
            all_timestamps = sorted(all_timestamps)
            fig.update_xaxes(
                range=[all_timestamps[0], all_timestamps[-1]],
                rangeslider_visible=False,
                type='date'
            )
    
    return json.dumps(fig, cls=plotly.utils.PlotlyJSONEncoder)

@app.route('/')
def index():
    """Home page"""
    return render_template('index.html')

_plotly_js_cache = None

@app.route('/vendor/plotly.min.js')
def plotly_js():
    """Serve plotly.js from the installed plotly package so the UI works without a CDN"""
    global _plotly_js_cache
    if _plotly_js_cache is None:
        from plotly.offline import get_plotlyjs
        _plotly_js_cache = get_plotlyjs()
    return Response(_plotly_js_cache, mimetype='application/javascript',
                    headers={'Cache-Control': 'public, max-age=86400'})

@app.route('/api/data-files')
def get_data_files():
    """Get available data file list"""
    data_files = load_data_files()
    return jsonify(data_files)

@app.route('/api/load-data', methods=['POST'])
def load_data():
    """Load data file"""
    try:
        data = request.get_json(silent=True) or {}
        file_path = data.get('file_path')

        if not file_path:
            return jsonify({'error': 'File path cannot be empty'}), 400

        df, error = load_data_file(file_path)
        if error:
            return jsonify({'error': error}), 400
        if len(df) == 0:
            return jsonify({'error': 'File contains no complete OHLC rows'}), 400

        # Downsampled close series for the window overview
        overview_stride = max(1, len(df) // 1200)

        # Return data information
        data_info = {
            'rows': len(df),
            'columns': list(df.columns),
            'start_date': df['timestamps'].min().isoformat() if 'timestamps' in df.columns else 'N/A',
            'end_date': df['timestamps'].max().isoformat() if 'timestamps' in df.columns else 'N/A',
            'price_range': {
                'min': float(df[['open', 'high', 'low', 'close']].min().min()),
                'max': float(df[['open', 'high', 'low', 'close']].max().max())
            },
            'prediction_columns': ['open', 'high', 'low', 'close'] + (['volume'] if 'volume' in df.columns else []),
            'timeframe': detect_timeframe(df),
            'has_volume': 'volume' in df.columns,
            # Row timestamps as seconds since epoch (naive timestamps treated as UTC) for exact window labels
            'timestamps': (df['timestamps'].astype('int64') // 10**9).tolist(),
            'overview': {
                'stride': overview_stride,
                'close': [float(v) for v in df['close'].iloc[::overview_stride]]
            }
        }

        return jsonify({
            'success': True,
            'data_info': data_info,
            'message': f'Successfully loaded data, total {len(df)} rows'
        })

    except Exception as e:
        return jsonify({'error': f'Failed to load data: {str(e)}'}), 500

@app.route('/api/predict', methods=['POST'])
def predict():
    """Perform prediction"""
    try:
        data = request.get_json(silent=True) or {}
        file_path = data.get('file_path')

        try:
            lookback = int(data.get('lookback', 400))
            pred_len = int(data.get('pred_len', 120))
            # Get prediction quality parameters
            temperature = float(data.get('temperature', 1.0))
            top_p = float(data.get('top_p', 0.9))
            sample_count = int(data.get('sample_count', 1))
        except (TypeError, ValueError):
            return jsonify({'error': 'Prediction parameters must be numeric'}), 400

        if not file_path:
            return jsonify({'error': 'File path cannot be empty'}), 400
        if lookback < 1 or pred_len < 1:
            return jsonify({'error': 'Lookback and prediction length must be at least 1'}), 400
        if temperature <= 0 or not (0 < top_p <= 1) or sample_count < 1:
            return jsonify({'error': 'Temperature must be > 0, top_p in (0, 1], sample count >= 1'}), 400

        if not MODEL_AVAILABLE or predictor is None:
            return jsonify({'error': 'Kronos model not loaded, please load model first'}), 400

        # Load data
        df, error = load_data_file(file_path)
        if error:
            return jsonify({'error': error}), 400

        if len(df) < lookback:
            return jsonify({'error': f'Insufficient data length, need at least {lookback} rows'}), 400

        # Resolve the window start: explicit row index, else first row at/after start_date, else first row
        start_index = data.get('start_index')
        start_date = data.get('start_date')
        if start_index is not None:
            try:
                start = int(start_index)
            except (TypeError, ValueError):
                return jsonify({'error': 'start_index must be an integer'}), 400
            if start < 0:
                return jsonify({'error': 'start_index must be non-negative'}), 400
            window_label = f'row {start}'
        elif start_date:
            start_dt = pd.to_datetime(start_date)
            positions = np.flatnonzero((df['timestamps'] >= start_dt).to_numpy())
            start = int(positions[0]) if len(positions) > 0 else len(df)
            window_label = start_dt.strftime("%Y-%m-%d %H:%M")
        else:
            start = 0
            window_label = None

        end = start + lookback + pred_len
        if end > len(df):
            available = max(0, len(df) - start)
            where = f' from {window_label}' if window_label else ''
            return jsonify({'error': f'Insufficient data{where}, need at least {lookback + pred_len} data points, currently only {available} available'}), 400

        context_df = df.iloc[start:start + lookback]
        actual_df = df.iloc[start + lookback:end]

        # Only use necessary columns: OHLCV, excluding amount
        required_cols = ['open', 'high', 'low', 'close']
        if 'volume' in df.columns:
            required_cols.append('volume')

        x_df = context_df[required_cols]
        # Series (not DatetimeIndex) to avoid .dt attribute errors in the Kronos model
        x_timestamp = context_df['timestamps'].reset_index(drop=True)
        y_timestamp = actual_df['timestamps'].reset_index(drop=True)

        time_span = actual_df['timestamps'].iloc[-1] - context_df['timestamps'].iloc[0]
        prediction_type = (f"Kronos model prediction (window starting at row {start}: first {lookback} data points "
                           f"for prediction, last {pred_len} data points for comparison, time span: {time_span})")

        try:
            pred_df = predictor.predict(
                df=x_df,
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=pred_len,
                T=temperature,
                top_p=top_p,
                sample_count=sample_count
            )
        except Exception as e:
            return jsonify({'error': f'Kronos model prediction failed: {str(e)}'}), 500

        historical_data = bars_to_records(context_df)
        actual_data = bars_to_records(actual_df)

        chart_json = create_prediction_chart(df, pred_df, lookback, pred_len, actual_df, start)

        # Forecast rows are aligned with the future timestamps passed to the predictor
        prediction_results = []
        for i, (_, row) in enumerate(pred_df.iterrows()):
            prediction_results.append({
                'timestamp': y_timestamp.iloc[i].isoformat() if i < len(y_timestamp) else f"T{i}",
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': float(row['volume']) if 'volume' in row else 0,
                'amount': float(row['amount']) if 'amount' in row else 0
            })

        prediction_params = {
            'lookback': lookback,
            'pred_len': pred_len,
            'temperature': temperature,
            'top_p': top_p,
            'sample_count': sample_count,
            'start_index': start,
            'start_date': start_date if start_date else context_df['timestamps'].iloc[0].isoformat()
        }

        # Save prediction results to file
        saved_path = save_prediction_results(
            file_path=file_path,
            prediction_type=prediction_type,
            prediction_results=prediction_results,
            actual_data=actual_data,
            input_data=x_df,
            prediction_params=prediction_params
        )

        return jsonify({
            'success': True,
            'prediction_type': prediction_type,
            'chart': chart_json,
            'prediction_results': prediction_results,
            'actual_data': actual_data,
            'historical_data': historical_data,
            'has_comparison': len(actual_data) > 0,
            'window': {
                'start_index': start,
                'end_index': end,
                'lookback': lookback,
                'pred_len': pred_len,
                'effective_context': min(lookback, getattr(predictor, 'max_context', lookback))
            },
            'params': prediction_params,
            'saved_file': os.path.basename(saved_path) if saved_path else None,
            'message': f'Prediction completed, generated {pred_len} prediction points' + (f', including {len(actual_data)} actual data points for comparison' if len(actual_data) > 0 else '')
        })

    except Exception as e:
        return jsonify({'error': f'Prediction failed: {str(e)}'}), 500

def current_model_info():
    """Describe the currently loaded model, or None"""
    if predictor is None or current_model_key not in AVAILABLE_MODELS:
        return None
    config = AVAILABLE_MODELS[current_model_key]
    return {
        'key': current_model_key,
        'name': config['name'],
        'params': config['params'],
        'context_length': config['context_length'],
        'description': config['description'],
        'device': current_device
    }

@app.route('/api/load-model', methods=['POST'])
def load_model():
    """Load Kronos model"""
    global tokenizer, model, predictor, current_model_key, current_device

    try:
        if not MODEL_AVAILABLE:
            return jsonify({'error': 'Kronos model library not available'}), 400

        data = request.get_json(silent=True) or {}
        model_key = data.get('model_key', 'kronos-small')
        device = data.get('device', 'cpu')

        if model_key not in AVAILABLE_MODELS:
            return jsonify({'error': f'Unsupported model: {model_key}'}), 400

        known_devices = {d['id']: d for d in detect_devices()}
        if device not in known_devices:
            return jsonify({'error': f'Unsupported device: {device}'}), 400
        if not known_devices[device]['available']:
            return jsonify({'error': f'Device {device} is not available on this machine'}), 400

        model_config = AVAILABLE_MODELS[model_key]

        # Load into locals first so a failed load leaves the previous model usable
        new_tokenizer = KronosTokenizer.from_pretrained(model_config['tokenizer_id'])
        new_model = Kronos.from_pretrained(model_config['model_id'])
        new_predictor = KronosPredictor(new_model, new_tokenizer, device=device, max_context=model_config['context_length'])

        tokenizer, model, predictor = new_tokenizer, new_model, new_predictor
        current_model_key, current_device = model_key, device

        return jsonify({
            'success': True,
            'message': f'Model loaded successfully: {model_config["name"]} ({model_config["params"]}) on {device}',
            'model_info': current_model_info()
        })

    except Exception as e:
        return jsonify({'error': f'Model loading failed: {str(e)}'}), 500

@app.route('/api/available-models')
def get_available_models():
    """Get available model list"""
    return jsonify({
        'models': AVAILABLE_MODELS,
        'model_available': MODEL_AVAILABLE,
        'devices': detect_devices(),
        'data_dirs': [os.path.relpath(d, PROJECT_ROOT) for d in DATA_DIRS]
    })

@app.route('/api/model-status')
def get_model_status():
    """Get model status"""
    if MODEL_AVAILABLE:
        info = current_model_info()
        if info is not None:
            return jsonify({
                'available': True,
                'loaded': True,
                'message': 'Kronos model loaded and available',
                'current_model': info
            })
        else:
            return jsonify({
                'available': True,
                'loaded': False,
                'message': 'Kronos model available but not loaded'
            })
    else:
        return jsonify({
            'available': False,
            'loaded': False,
            'message': 'Kronos model library not available, please install related dependencies'
        })

if __name__ == '__main__':
    print("Starting Kronos Web UI...")
    print(f"Model availability: {MODEL_AVAILABLE}")
    if MODEL_AVAILABLE:
        print("Tip: Load a Kronos model from the Model panel in the browser")
    else:
        print("Tip: Install the dependencies in requirements.txt to enable forecasting")

    app.run(debug=True, host='0.0.0.0', port=7070)
