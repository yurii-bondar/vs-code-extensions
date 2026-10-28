package io.github.yuriibondar.claudestrator.engine

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive

// The Kotlin side of the stdio wire; the other side is sidecar/src/protocol.ts. What the engine sends is read once,
// here, into plain types, so nothing else handles raw JSON.

internal fun JsonObject.str(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.asString
internal fun JsonObject.bool(key: String): Boolean = (get(key) as? JsonPrimitive)?.takeIf { it.isBoolean }?.asBoolean ?: false
internal fun JsonObject.int(key: String): Int? = (get(key) as? JsonPrimitive)?.takeIf { it.isNumber }?.asInt
internal fun JsonObject.double(key: String): Double? = (get(key) as? JsonPrimitive)?.takeIf { it.isNumber }?.asDouble
internal fun JsonObject.obj(key: String): JsonObject? = get(key) as? JsonObject
internal fun JsonObject.array(key: String): JsonArray = get(key) as? JsonArray ?: JsonArray()

internal fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject {
    val o = JsonObject()
    for ((k, v) in pairs) {
        when (v) {
            null -> Unit
            is JsonElement -> o.add(k, v)
            is String -> o.addProperty(k, v)
            is Boolean -> o.addProperty(k, v)
            is Number -> o.addProperty(k, v)
            is Iterable<*> -> o.add(k, JsonArray().also { a -> v.forEach { item -> a.add(if (item is String) JsonPrimitive(item) else item as JsonElement) } })
            else -> error("unsupported JSON value for $k: ${v::class}")
        }
    }
    return o
}

/** A task as the list shows it. `group` is where it sits: attention, running, stopped or done. */
data class TaskCard(
    val taskId: String,
    val title: String,
    val statusKey: String,
    val statusLabel: String,
    val group: String,
    val liveText: String?,
    val updatedAt: String?,
    val checkpointHint: String?,
    val errorMessage: String?,
    val prs: List<String>,
    val outcome: String?,
) {
    val resumable get() = statusKey in RESUMABLE
    val running get() = statusKey == "running"
    val waiting get() = statusKey == "waiting"

    companion object {
        private val RESUMABLE = setOf("stopped", "failed", "interrupted", "ready")

        fun parse(e: JsonElement): TaskCard? {
            val o = e as? JsonObject ?: return null
            val status = o.obj("status") ?: return null
            return TaskCard(
                taskId = o.str("taskId") ?: return null,
                title = o.str("title") ?: o.str("taskId") ?: return null,
                statusKey = status.str("key") ?: "ready",
                statusLabel = status.str("label") ?: "",
                group = status.str("group") ?: "stopped",
                liveText = o.obj("live")?.str("text"),
                updatedAt = o.str("updatedAt"),
                checkpointHint = o.obj("checkpoint")?.str("hint"),
                errorMessage = o.obj("error")?.str("message"),
                prs = o.obj("prs")?.entrySet()?.mapNotNull { (it.value as? JsonPrimitive)?.asString } ?: emptyList(),
                outcome = o.str("outcome"),
            )
        }
    }
}

/** One of the account's usage windows. `reset` means the window has rolled over since it was measured. */
data class LimitWindow(val pct: Int, val resetsAt: Long?, val reset: Boolean)

data class Limits(val fiveHour: LimitWindow?, val sevenDay: LimitWindow?, val at: Long?, val source: String?) {
    val max: Int get() = maxOf(fiveHour?.pct ?: 0, sevenDay?.pct ?: 0)

    companion object {
        private fun window(o: JsonObject?): LimitWindow? = o?.let { LimitWindow(it.int("pct") ?: return null, it.double("resetsAt")?.toLong(), it.bool("reset")) }

        fun parse(e: JsonElement?): Limits? {
            val o = e as? JsonObject ?: return null
            val limits = Limits(window(o.obj("fiveHour")), window(o.obj("sevenDay")), o.double("at")?.toLong(), o.str("source"))
            return if (limits.fiveHour == null && limits.sevenDay == null) null else limits
        }
    }
}

/** What the engine last reported: the task list, the usage limits and whether a workspace folder is open. */
data class EngineState(val root: String?, val cards: List<TaskCard>, val limits: Limits?) {
    val attention: Int get() = cards.count { it.group == "attention" }
    val running: Int get() = cards.count { it.group == "running" }

    companion object {
        val EMPTY = EngineState(null, emptyList(), null)

        fun parse(o: JsonObject) = EngineState(o.str("root"), o.array("cards").mapNotNull { TaskCard.parse(it) }, Limits.parse(o.get("limits")))
    }
}
