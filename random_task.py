
import sys
import time
import random
from datetime import datetime

def main():
    try:
        duration_secs = int(sys.argv[1])
    except (IndexError, ValueError):
        print("Usage: python random_task.py <seconds>")
        sys.exit(1) # Exit with an error if args are wrong

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Task started. Will run for {duration_secs} seconds.")
    
    time.sleep(duration_secs)
    
    # Randomly choose the exit code: 0 for success, 1 for failure.
    exit_code = random.choice([0, 1])
    
    if exit_code == 0:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Task finished. Result: SUCCESS (Exit Code 0)")
        sys.exit(0)
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Task finished. Result: FAILURE (Exit Code 1)")
        sys.exit(1)

if __name__ == "__main__":
    main()
