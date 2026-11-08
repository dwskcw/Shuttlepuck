import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    raise ValueError("Gemini API key not found!")

client = genai.Client(api_key=api_key)

print("Sending request...", flush=True)

try:
    stream = client.interactions.create(
        model="gemini-3.8-flash",
        input="Explain how AI works",
        stream=True
    )

    print("Stream established!", flush=True)

    for event in stream:
        if event.event_type == "step.delta":
            if event.delta.type == "text":
                print(event.delta.text, end="", flush=True)

    print("\nFinished!")

except Exception as e:
    print("Error:", repr(e))