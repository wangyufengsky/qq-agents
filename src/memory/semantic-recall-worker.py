"""Local embedding and bounded, disposable vector indexes for QQ recall."""

import heapq
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

DIMENSION = 512
MIN_SCORE = 0.50
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


class Index:
    def __init__(self, limit):
        self.vectors = np.empty((limit, DIMENSION), dtype=np.float32)
        self.entries = []
        self.age = []
        self.sequences = np.empty(limit, dtype=np.int64)
        self.times = np.empty(limit, dtype=np.int64)

    def add(self, entry, vector):
        seq, at = entry["seq"], entry["at"]
        if len(self.entries) == len(self.vectors):
            if seq <= self.age[0][0]:
                return
            slot = self.age[0][1]
            heapq.heapreplace(self.age, (seq, slot))
        else:
            slot = len(self.entries)
            self.entries.append(None)
            heapq.heappush(self.age, (seq, slot))
        self.entries[slot] = {"id": entry["id"], "digest": entry["digest"]}
        self.vectors[slot] = vector
        self.sequences[slot] = seq
        self.times[slot] = at

    def search(self, vector, before, to, known):
        size = len(self.entries)
        scores = np.einsum("ij,j->i", self.vectors[:size], vector)
        eligible = np.flatnonzero(
            (scores >= MIN_SCORE) & (self.sequences[:size] < before)
            & (self.times[:size] <= to)
        )
        matches = heapq.nlargest(
            12,
            (i for i in eligible if self.entries[i]["id"] not in known),
            key=lambda i: (scores[i], self.sequences[i]),
        )
        return [self.entries[i] for i in matches]


def main():
    root = Path(sys.argv[1])
    tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
    tokenizer.enable_padding()
    tokenizer.enable_truncation(128)
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    model = ort.InferenceSession(
        str(root / "model_int8.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    names = [item.name for item in model.get_inputs()]

    def embed(texts):
        tokens = tokenizer.encode_batch(texts)
        inputs = {
            "input_ids": np.asarray([item.ids for item in tokens], dtype=np.int64),
            "attention_mask": np.asarray(
                [item.attention_mask for item in tokens], dtype=np.int64
            ),
            "token_type_ids": np.asarray(
                [item.type_ids for item in tokens], dtype=np.int64
            ),
        }
        vectors = model.run(None, {name: inputs[name] for name in names})[0][:, 0]
        return vectors / np.maximum(
            np.linalg.norm(vectors, axis=-1, keepdims=True), 1e-12
        )

    indexes = {}
    for line in sys.stdin:
        request = json.loads(line)
        op, scope = request["op"], request["scope"]
        if op == "index":
            rows = request["rows"]
            if scope not in indexes:
                indexes[scope] = Index(request["limit"])
            for row, vector in zip(rows, embed([row["body"] for row in rows])):
                indexes[scope].add(row, vector)
            result = []
        elif op == "query":
            index = indexes.get(scope)
            result = index.search(
                embed([QUERY_PREFIX + request["query"]])[0],
                request["beforeSeq"],
                request["to"],
                set(request["known"]),
            ) if index else []
        else:
            raise ValueError("unsupported request")
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
