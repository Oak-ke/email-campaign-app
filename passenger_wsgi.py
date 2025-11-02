import sys
import os

# Add your app's directory to the Python path
sys.path.insert(0, os.path.dirname(__file__))

# Import your Flask app
from app import app as application