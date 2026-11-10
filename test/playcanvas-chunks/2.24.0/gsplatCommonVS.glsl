
#include "gsplatHelpersVS"
#include "gsplatFormatVS"
#include "gsplatStructsVS"
#include "gsplatDeclarationsVS"
#include "gsplatModifyVS"
#include "gsplatEvalSHVS"
#include "gsplatQuatToMat3VS"
#include "gsplatReadVS"
#include "gsplatSourceVS"
#include "gsplatCenterVS"
#include "gsplatCornerVS"
#include "gsplatOutputVS"
#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
uniform float alphaClip;
#else
uniform float alphaClipForward;
#endif
void clipCorner(inout SplatCorner corner, float alpha) {
	#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
		float alphaClipValue = alphaClip;
	#else
		float alphaClipValue = alphaClipForward;
	#endif
	float clip = min(1.0, sqrt(max(0.0, log(min(alpha, 1.0) / alphaClipValue))) * 0.5);
	if (alpha > 1.0) {
		float core = gsplatPlateauCore(alpha);
		clip = core + (1.0 - core) * clip;
	}
	corner.offset *= clip;
	corner.uv *= clip;
}
