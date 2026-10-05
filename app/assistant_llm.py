"""Размер каждого запроса помощника и повтор при меньшем контексте сервера."""
import json
import re
from app.calc import qwen_client, runtime


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Dialogue:
    def __init__(self, cfg, context_tokens, cancel, progress, stage):
        self.cfg, self.cancel, self.progress, self.stage = cfg, cancel, progress, stage
        # Настройка клиента не увеличивает уже загруженный контекст OpenAI-сервера.
        # До подтверждения сервером используем совместимый с 8K размер на ВСЕХ этапах.
        self.context = min(context_tokens, 8192)
        self.factor = 1.4

    def call(self, messages, schema, name, shrink, max_tokens=None):
        thinking_retry = False
        for attempt in range(3):
            base_output = min(max_tokens or self.cfg.maxTokens, max(512, self.context // 3))
            output = min(self.cfg.maxTokens, 4096, self.context // 2) if thinking_retry else base_output
            budget = self.context - output - 512 - len(encoded(schema)) / self.factor
            while sum(len(m["content"]) for m in messages) / self.factor > budget:
                if self.cancel():
                    raise qwen_client.InferenceCancelled()
                if not shrink():
                    # Сохраняем обязательные данные поиска; резерв повторного ответа
                    # может быть меньше 4096, но должен превышать исходный.
                    available = int(self.context - 512 - len(encoded(schema))/self.factor - sum(len(m["content"]) for m in messages)/self.factor)
                    if thinking_retry and available > base_output:
                        output = min(output, available)
                        break
                    if not thinking_retry and available >= 512:
                        output = min(output, available)
                        self.stage("compact", "Сохраняем необходимые данные и уменьшаем резерв ответа", outputTokens=output)
                        break
                    raise qwen_client.InferenceError("Вопрос и необходимые данные не помещаются в контекст модели. Разделите вопрос на несколько частей.")
            try:
                return qwen_client.chat(self.cfg.model_copy(update={"maxTokens": output}), runtime.settings(), messages, schema, name,
                                        progress=self.progress, cancel=self.cancel, context_tokens=self.context, disable_thinking=True, reasoning_guard=False)
            except qwen_client.InferenceError as error:
                if isinstance(error, qwen_client.InferenceCancelled):
                    raise
                if isinstance(error, qwen_client.InferenceTruncated) and error.thinking:
                    if thinking_retry or attempt == 2 or min(self.cfg.maxTokens, 4096, self.context // 2) <= output:
                        raise qwen_client.InferenceError("Модель потратила лимит на рассуждения и не вернула результат при запросе отключить рассуждения. Сервер не отключил Thinking по запросу сервиса — отключите этот режим в настройках загруженной модели на сервере ИИ.") from None
                    thinking_retry = True
                    self.stage("reasoning_retry", "Повторяем запрос с большим резервом для результата")
                    continue
                text = str(error)
                limit = re.search(r'(?:n_ctx[\s\"\'\\:]+|available context size\s*\(|context (?:size|length)\s*[:=]\s*)(\d+)', text)
                tokens = re.search(r'(?:n_prompt_tokens[\s\"\'\\:]+|request\s*\()(\d+)', text)
                overflow = "exceed" in text.lower() and "context" in text.lower()
                if not overflow:
                    raise
                if attempt == 2:
                    raise qwen_client.InferenceError("Сервер модели отклонил запрос из-за размера контекста даже после сокращения. Разделите вопрос на несколько частей или увеличьте контекст загруженной модели на сервере.") from None
                if limit:
                    self.context = min(self.context, int(limit[1]))
                else:
                    self.context = max(1024, self.context // 2)
                # Калибруем оценку по фактическому числу токенов, если сервер его сообщил.
                if tokens:
                    self.factor = min(self.factor, sum(len(m["content"]) for m in messages) / max(1, int(tokens[1])) * .75)
                else:
                    self.factor *= .65
                self.stage("compact", "Сокращаем контекст до лимита сервера и повторяем запрос", contextTokens=self.context)
        raise AssertionError("недостижимая ветка")


def trim_history(history):
    if len(history) > 2:
        del history[:2]
        return True
    for message in history:
        if len(message["content"]) > 500:
            message["content"] = message["content"][:300] + "…" + message["content"][-199:]
            return True
    return False
